import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Account } from './domain.ts'
import { AccountManager } from './manager.ts'
import { applicationPaths } from './paths.ts'
import { createProxyHandler, createUsageObserver, proxyIdentity, startProxy } from './proxy.ts'
import { createStateStore } from './storage.ts'
import type { CredentialVault } from './vault.ts'

const clientToken = 'test-only-quotanaut-client-token'

function memoryVault(initial: Record<string, string>): CredentialVault {
	const values = new Map(Object.entries(initial))
	return {
		read: async reference => values.get(reference) ?? null,
		remove: async reference => {
			values.delete(reference)
		},
		write: async (reference, value) => {
			values.set(reference, value)
		}
	}
}

function codexAccount(n: number): Account {
	const identity = `user${n}@example.com`
	return {
		auth: 'oauth',
		createdAt: '2026-08-12T00:00:00.000Z',
		enabled: true,
		externalAccountId: `chatgpt-account-${n}`,
		externalUserId: `chatgpt-user-${n}`,
		health: 'ready',
		id: `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`,
		identity,
		label: identity,
		onThreshold: 'switch',
		plan: 'pro',
		profilePath: null,
		provider: 'openai',
		secretReference: `codex:${n}`,
		updatedAt: '2026-08-12T00:00:00.000Z'
	}
}

type Observed = {
	model: string | null
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheCreationTokens: number
}

function observe(body: string, chunkSize = 7): Observed | null {
	let seen: Observed | null = null
	const observer = createUsageObserver(usage => {
		seen = usage
	})
	const bytes = new TextEncoder().encode(body)
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		observer.push(bytes.slice(offset, offset + chunkSize))
	}
	observer.finish()
	return seen
}

describe('createUsageObserver', () => {
	test('codex SSE stream without content-type', () => {
		const body = [
			'event: response.created',
			'data: {"type":"response.created","response":{"id":"resp_1"}}',
			'',
			'event: response.output_text.delta',
			'data: {"type":"response.output_text.delta","delta":"OK"}',
			'',
			'event: response.completed',
			'data: {"type":"response.completed","response":{"model":"gpt-5.6-sol","usage":{"input_tokens":21,"input_tokens_details":{"cache_write_tokens":0,"cached_tokens":16},"output_tokens":5,"total_tokens":26}}}',
			''
		].join('\n')
		expect(observe(body)).toEqual({
			cacheCreationTokens: 0,
			cacheReadTokens: 16,
			inputTokens: 5,
			model: 'gpt-5.6-sol',
			outputTokens: 5
		})
	})

	test('openai non-streaming JSON response', () => {
		const body = JSON.stringify({
			model: 'gpt-5.6-sol',
			object: 'response',
			usage: {
				input_tokens: 100,
				input_tokens_details: { cached_tokens: 60 },
				output_tokens: 20
			}
		})
		expect(observe(body)).toEqual({
			cacheCreationTokens: 0,
			cacheReadTokens: 60,
			inputTokens: 40,
			model: 'gpt-5.6-sol',
			outputTokens: 20
		})
	})

	test('emits nothing for bodies without usage', () => {
		expect(observe('{"type":"error","error":{"message":"nope"}}')).toBeNull()
		expect(observe('not json at all')).toBeNull()
	})

	test('final SSE line without trailing newline still counts', () => {
		const body =
			'data: {"type":"response.completed","response":{"model":"gpt-5.6-sol","usage":{"input_tokens":10,"output_tokens":2}}}'
		expect(observe(body)?.outputTokens).toBe(2)
	})
})

describe('proxyIdentity', () => {
	test('recognizes the Quotanaut proxy by its identity response', async () => {
		const proxy = startProxy({
			clientToken,
			source: { refresh: async () => undefined, resolve: async () => null }
		})
		try {
			expect(await proxyIdentity(proxy.port)).toBe('quotanaut')
		} finally {
			await proxy.stop()
		}
	})

	test('reports a foreign listener without claiming it', async () => {
		const server = Bun.serve({
			fetch: () => new Response('hello'),
			hostname: '127.0.0.1',
			port: 0
		})
		const port = server.port
		if (port === undefined) {
			throw new Error('server did not bind')
		}
		try {
			expect(await proxyIdentity(port)).toBe('foreign')
		} finally {
			await server.stop(true)
		}
	})

	test('reports a free port as nothing listening', async () => {
		const server = Bun.serve({
			fetch: () => new Response(''),
			hostname: '127.0.0.1',
			port: 0
		})
		const port = server.port
		if (port === undefined) {
			throw new Error('server did not bind')
		}
		await server.stop(true)
		expect(await proxyIdentity(port)).toBe(null)
	})
})

describe('authenticated proxy', () => {
	test('keeps the identity probe available without client authentication', async () => {
		let resolved = 0
		const proxy = createProxyHandler({
			clientToken,
			source: {
				refresh: async () => undefined,
				resolve: async () => {
					resolved += 1
					return null
				}
			}
		})
		const response = await proxy.handle(new Request('http://127.0.0.1/'))
		expect(response.status).toBe(404)
		expect(await response.text()).toStartWith('quotanaut proxy')
		expect(resolved).toBe(0)
	})

	test('rejects missing or invalid credentials before resolving or forwarding', async () => {
		let resolved = 0
		let forwarded = 0
		const proxy = createProxyHandler({
			clientToken,
			fetchImplementation: async () => {
				forwarded += 1
				return new Response('unexpected')
			},
			source: {
				refresh: async () => undefined,
				resolve: async () => {
					resolved += 1
					return null
				}
			}
		})
		const rejectedHeaders: (HeadersInit | undefined)[] = [
			undefined,
			{ authorization: 'Bearer wrong-token' },
			{ authorization: `bearer ${clientToken}` },
			{ authorization: `Bearer  ${clientToken}` },
			{ 'x-api-key': clientToken }
		]
		for (const headers of rejectedHeaders) {
			const response = await proxy.handle(
				new Request('http://127.0.0.1/openai/responses', {
					body: 'request body that must not be forwarded',
					headers,
					method: 'POST'
				})
			)
			expect(response.status).toBe(401)
			expect(response.headers.get('x-quotanaut-error')).toBe('proxy-authentication-required')
			const responseBody = await response.text()
			expect(responseBody).not.toContain(clientToken)
			expect(responseBody).not.toContain('request body that must not be forwarded')
		}
		expect(resolved).toBe(0)
		expect(forwarded).toBe(0)
	})

	test('accepts the exact bearer token and strips client credentials and identity headers', async () => {
		const forwardedHeaders: Headers[] = []
		const proxy = createProxyHandler({
			clientToken,
			fetchImplementation: async (_input, initialization) => {
				forwardedHeaders.push(new Headers(initialization?.headers))
				return new Response('ok', {
					headers: {
						connection: 'keep-alive',
						'keep-alive': 'timeout=5',
						'proxy-authenticate': 'Basic realm="upstream"',
						'set-cookie': 'upstream-session=secret',
						trailer: 'x-upstream-trailer',
						upgrade: 'websocket'
					}
				})
			},
			source: {
				refresh: async () => undefined,
				resolve: async () => ({
					accountId: 'account-1',
					baseUrl: 'https://chatgpt.com/backend-api/codex',
					headers: {
						authorization: 'Bearer upstream-credential',
						'chatgpt-account-id': 'chatgpt-account-1'
					}
				})
			}
		})
		const responses = await Promise.all([
			proxy.handle(
				new Request('http://127.0.0.1/openai/responses', {
					headers: {
						authorization: `Bearer ${clientToken}`,
						'chatgpt-account-id': 'client-chatgpt-account',
						cookie: 'browser-session=secret',
						'openai-account-id': 'client-openai-account',
						'openai-organization': 'client-organization',
						'openai-project': 'client-project',
						'proxy-authorization': 'Basic client-proxy-secret',
						'x-openai-account-id': 'client-x-openai-account',
						'x-openai-organization': 'client-x-organization',
						'x-openai-project': 'client-x-project'
					}
				})
			),
			proxy.handle(
				new Request('http://127.0.0.1/openai/responses', {
					headers: {
						authorization: `Bearer ${clientToken}`,
						cookie: 'browser-session=secret',
						'x-api-key': 'client-api-key'
					}
				})
			)
		])
		expect(responses.map(response => response.status)).toEqual([200, 200])
		for (const response of responses) {
			expect(response.headers.get('connection')).toBeNull()
			expect(response.headers.get('keep-alive')).toBeNull()
			expect(response.headers.get('proxy-authenticate')).toBeNull()
			expect(response.headers.get('set-cookie')).toBeNull()
			expect(response.headers.get('trailer')).toBeNull()
			expect(response.headers.get('upgrade')).toBeNull()
		}
		expect(forwardedHeaders).toHaveLength(2)
		for (const headers of forwardedHeaders) {
			expect(headers.get('authorization')).toBe('Bearer upstream-credential')
			expect(headers.get('chatgpt-account-id')).toBe('chatgpt-account-1')
			expect(headers.get('cookie')).toBeNull()
			expect(headers.get('openai-account-id')).toBeNull()
			expect(headers.get('openai-organization')).toBeNull()
			expect(headers.get('openai-project')).toBeNull()
			expect(headers.get('proxy-authorization')).toBeNull()
			expect(headers.get('x-openai-account-id')).toBeNull()
			expect(headers.get('x-openai-organization')).toBeNull()
			expect(headers.get('x-openai-project')).toBeNull()
			expect(headers.get('x-api-key')).toBeNull()
		}
	})

	test('replays a 429 on the account selected by the limit observer', async () => {
		let activeAccountId = 'account-1'
		const forwardedAccounts: string[] = []
		const forwardedCredentials: string[] = []
		const requestBodies: string[] = []
		const proxy = createProxyHandler({
			clientToken,
			fetchImplementation: async (_input, initialization) => {
				const headers = new Headers(initialization?.headers)
				forwardedAccounts.push(headers.get('chatgpt-account-id') ?? '')
				forwardedCredentials.push(headers.get('authorization') ?? '')
				const body = initialization?.body
				requestBodies.push(
					body instanceof ArrayBuffer ? new TextDecoder().decode(body) : String(body ?? '')
				)
				return forwardedAccounts.length === 1
					? new Response('limited', { status: 429 })
					: new Response('served by account 2')
			},
			observeLimits: event => {
				expect(event.accountId).toBe('account-1')
				expect(event.observation.limited).toBe(true)
				activeAccountId = 'account-2'
			},
			source: {
				refresh: async () => undefined,
				resolve: async () => ({
					accountId: activeAccountId,
					baseUrl: 'https://chatgpt.com/backend-api/codex',
					headers: {
						authorization: `Bearer credential-${activeAccountId}`,
						'chatgpt-account-id': activeAccountId
					}
				})
			}
		})
		const response = await proxy.handle(
			new Request('http://127.0.0.1/openai/responses', {
				body: 'same request body',
				headers: { authorization: `Bearer ${clientToken}` },
				method: 'POST'
			})
		)
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('served by account 2')
		expect(forwardedAccounts).toEqual(['account-1', 'account-2'])
		expect(forwardedCredentials).toEqual([
			'Bearer credential-account-1',
			'Bearer credential-account-2'
		])
		expect(requestBodies).toEqual(['same request body', 'same request body'])
	})

	test('returns a 429 without replay when automation keeps the same account active', async () => {
		let forwarded = 0
		const proxy = createProxyHandler({
			clientToken,
			fetchImplementation: async () => {
				forwarded += 1
				return new Response('still limited', { status: 429 })
			},
			observeLimits: async () => undefined,
			source: {
				refresh: async () => undefined,
				resolve: async () => ({
					accountId: 'account-1',
					baseUrl: 'https://chatgpt.com/backend-api/codex',
					headers: { authorization: 'Bearer credential-account-1' }
				})
			}
		})

		const response = await proxy.handle(
			new Request('http://127.0.0.1/openai/responses', {
				headers: { authorization: `Bearer ${clientToken}` }
			})
		)

		expect(response.status).toBe(429)
		expect(await response.text()).toBe('still limited')
		expect(forwarded).toBe(1)
	})

	test('replays only once and persists the second 429 before returning it', async () => {
		let activeAccountId = 'account-1'
		let deliveredSecondLimit = false
		const forwardedAccounts: string[] = []
		const proxy = createProxyHandler({
			clientToken,
			fetchImplementation: async (_input, initialization) => {
				forwardedAccounts.push(new Headers(initialization?.headers).get('chatgpt-account-id') ?? '')
				return new Response(`limited ${activeAccountId}`, { status: 429 })
			},
			observeLimits: async event => {
				if (event.accountId === 'account-1') {
					activeAccountId = 'account-2'
					return
				}
				await Bun.sleep(5)
				deliveredSecondLimit = true
				activeAccountId = 'account-3'
			},
			source: {
				refresh: async () => undefined,
				resolve: async () => ({
					accountId: activeAccountId,
					baseUrl: 'https://chatgpt.com/backend-api/codex',
					headers: {
						authorization: `Bearer credential-${activeAccountId}`,
						'chatgpt-account-id': activeAccountId
					}
				})
			}
		})

		const response = await proxy.handle(
			new Request('http://127.0.0.1/openai/responses', {
				headers: { authorization: `Bearer ${clientToken}` }
			})
		)

		expect(response.status).toBe(429)
		expect(await response.text()).toBe('limited account-2')
		expect(forwardedAccounts).toEqual(['account-1', 'account-2'])
		expect(deliveredSecondLimit).toBe(true)
		expect(activeAccountId).toBe('account-3')
	})

	test('returns a replayed streaming response before its stream closes', async () => {
		let activeAccountId = 'account-1'
		let closeReplay: (() => void) | undefined
		const replayClosed = new Promise<void>(resolve => {
			closeReplay = resolve
		})
		const proxy = createProxyHandler({
			clientToken,
			fetchImplementation: async () => {
				if (activeAccountId === 'account-1') {
					return new Response('limited', { status: 429 })
				}
				return new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(new TextEncoder().encode('first chunk'))
							await replayClosed
							controller.close()
						}
					})
				)
			},
			observeLimits: () => {
				activeAccountId = 'account-2'
			},
			source: {
				refresh: async () => undefined,
				resolve: async () => ({
					accountId: activeAccountId,
					baseUrl: 'https://chatgpt.com/backend-api/codex',
					headers: { authorization: `Bearer credential-${activeAccountId}` }
				})
			}
		})

		const response = await proxy.handle(
			new Request('http://127.0.0.1/openai/responses', {
				headers: { authorization: `Bearer ${clientToken}` }
			})
		)
		const reader = response.body?.getReader()
		if (reader === undefined) {
			throw new Error('replayed response has no stream')
		}
		const first = await reader.read()
		expect(new TextDecoder().decode(first.value)).toBe('first chunk')
		expect(first.done).toBe(false)
		closeReplay?.()
		expect((await reader.read()).done).toBe(true)
	})

	test('persists an automatic switch and replays the same request through the next account', async () => {
		const root = mkdtempSync(join(tmpdir(), 'quotanaut-manager-proxy-'))
		const now = new Date()
		const paths = applicationPaths({ QUOTANAUT_HOME: root })
		const store = createStateStore(paths.database)
		const first = codexAccount(1)
		const second = codexAccount(2)
		const vault = memoryVault({
			[first.secretReference]: 'unused-first-secret',
			[second.secretReference]: 'unused-second-secret'
		})
		const manager = new AccountManager({
			dependencies: { now: () => now },
			paths,
			store,
			vault
		})
		try {
			store.saveAccount(first)
			store.saveAccount(second)
			store.saveUsage({
				accountId: second.id,
				extraUsage: null,
				hardLimitReached: false,
				measuredSpendUsd: null,
				observedAt: new Date(now.getTime() - 30_000).toISOString(),
				provider: 'openai',
				resetCredits: null,
				source: 'codexUsageEndpoint',
				windows: [
					{
						id: 'codex:primary',
						kind: 'hard',
						label: '5 hour',
						resetAt: null,
						usedPercent: 10
					}
				]
			})
			store.saveProviderState({
				activeAccountId: first.id,
				generation: 1,
				policy: {
					authorization: 'confirmed',
					enabled: true,
					hiddenWindowIds: [],
					hysteresisPercent: 5,
					maximumSnapshotAgeMilliseconds: 420_000,
					minimumDwellMilliseconds: 300_000,
					provider: 'openai',
					thresholdPercent: 90
				},
				provider: 'openai',
				switchedAt: new Date(now.getTime() - 10 * 60_000).toISOString()
			})

			const forwardedAccounts: string[] = []
			const requestBodies: string[] = []
			const proxy = createProxyHandler({
				clientToken,
				fetchImplementation: async (_input, initialization) => {
					const headers = new Headers(initialization?.headers)
					forwardedAccounts.push(headers.get('chatgpt-account-id') ?? '')
					const body = initialization?.body
					requestBodies.push(
						body instanceof ArrayBuffer ? new TextDecoder().decode(body) : String(body ?? '')
					)
					return forwardedAccounts.length === 1
						? new Response('limited', { status: 429 })
						: new Response('served by account 2')
				},
				observeLimits: event => manager.noteRateLimitObservation(event),
				source: {
					refresh: async () => undefined,
					resolve: async () => {
						const active = manager.activeAccount('openai')
						return active === null
							? null
							: {
									accountId: active.id,
									baseUrl: 'https://chatgpt.com/backend-api/codex',
									headers: {
										authorization: `Bearer upstream-${active.id}`,
										'chatgpt-account-id': active.externalAccountId ?? ''
									}
								}
					}
				}
			})

			const response = await proxy.handle(
				new Request('http://127.0.0.1/openai/responses', {
					body: 'identical request body',
					headers: { authorization: `Bearer ${clientToken}` },
					method: 'POST'
				})
			)

			expect(response.status).toBe(200)
			expect(await response.text()).toBe('served by account 2')
			expect(forwardedAccounts).toEqual([
				first.externalAccountId ?? '',
				second.externalAccountId ?? ''
			])
			expect(requestBodies).toEqual(['identical request body', 'identical request body'])
			expect(store.findProviderState('openai')).toMatchObject({
				activeAccountId: second.id,
				generation: 2
			})
			expect(store.findUsage(first.id)).toMatchObject({
				hardLimitReached: true,
				source: 'proxyResponseHeaders'
			})
			expect(store.listSwitchRecords(1)[0]).toMatchObject({
				phase: 'committed',
				reason: 'automatic:hardLimit',
				sourceAccountId: first.id,
				targetAccountId: second.id
			})
		} finally {
			store.close()
			rmSync(root, { force: true, recursive: true })
		}
	})

	test('does not expose non-openai routes', async () => {
		let resolved = 0
		const proxy = createProxyHandler({
			clientToken,
			source: {
				refresh: async () => undefined,
				resolve: async () => {
					resolved += 1
					return null
				}
			}
		})
		const response = await proxy.handle(
			new Request('http://127.0.0.1/unsupported/v1/messages', {
				headers: { authorization: `Bearer ${clientToken}` }
			})
		)
		expect(response.status).toBe(404)
		expect(resolved).toBe(0)
	})
})
