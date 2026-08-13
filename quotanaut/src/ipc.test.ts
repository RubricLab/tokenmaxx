import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { managerRequest, startManagerServer } from './ipc.ts'

const socketPaths: string[] = []

afterEach(async () => {
	await Promise.all(socketPaths.splice(0).map(path => rm(path, { force: true })))
})

function socketPath(): string {
	const path = join(tmpdir(), `quotanaut-ipc-test-${process.pid}-${crypto.randomUUID()}.sock`)
	socketPaths.push(path)
	return path
}

function oversizedSocketRequest(path: string, bytes: number): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path)
		let buffer = ''
		socket.setEncoding('utf8')
		socket.once('connect', () => {
			socket.write(`${'x'.repeat(bytes)}\n`)
		})
		socket.on('data', chunk => {
			buffer += chunk
			const newline = buffer.indexOf('\n')
			if (newline < 0) {
				return
			}
			socket.end()
			try {
				resolve(JSON.parse(buffer.slice(0, newline)))
			} catch (error) {
				reject(error)
			}
		})
		socket.once('error', reject)
	})
}

describe('manager IPC limits', () => {
	test('rejects raw request frames over 2 MiB before JSON parsing', async () => {
		const path = socketPath()
		const server = await startManagerServer({
			manager: {} as never,
			onStop: () => undefined,
			socketPath: path
		})
		try {
			expect(await oversizedSocketRequest(path, 2 * 1024 * 1024 + 1)).toEqual({
				error: { code: 'REQUEST_TOO_LARGE', message: 'Manager request exceeds the 2 MiB limit' },
				id: 0
			})
		} finally {
			await server.close()
		}
	})

	test('rejects account save payloads over 1 MiB', async () => {
		const path = socketPath()
		const manager = {
			saveAccount: async () => {
				throw new Error('oversized payload must not reach manager')
			}
		}
		const server = await startManagerServer({
			manager: manager as never,
			onStop: () => undefined,
			socketPath: path
		})
		try {
			await expect(
				managerRequest({
					method: 'account/save',
					params: { serializedAuth: 'x'.repeat(1024 * 1024 + 1) },
					schema: z.unknown(),
					socketPath: path
				})
			).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
		} finally {
			await server.close()
		}
	})
})
