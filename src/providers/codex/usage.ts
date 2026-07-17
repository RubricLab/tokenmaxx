import { z } from 'zod'
import type { UsageSnapshot, UsageWindow } from '../../domain.ts'
import { ApplicationError } from '../../errors.ts'
import type { FetchImplementation } from '../../http.ts'
import type { CodexAuth } from './auth.ts'
import { codexIdentity } from './auth.ts'

const usageEndpoint = 'https://chatgpt.com/backend-api/wham/usage'

const WindowSchema = z
	.object({
		limit_window_seconds: z.number().nonnegative().optional(),
		reset_at: z.number().nonnegative().optional(),
		used_percent: z.number().min(0).max(100)
	})
	.passthrough()

const LimitDetailsSchema = z
	.object({
		allowed: z.boolean().optional(),
		limit_reached: z.boolean().optional(),
		primary_window: WindowSchema.nullish(),
		secondary_window: WindowSchema.nullish()
	})
	.passthrough()

const AdditionalLimitSchema = z
	.object({
		limit_name: z.string().min(1),
		metered_feature: z.string().min(1),
		rate_limit: LimitDetailsSchema.nullish()
	})
	.passthrough()

const UsageResponseSchema = z
	.object({
		additional_rate_limits: z.array(AdditionalLimitSchema).nullish(),
		rate_limit: LimitDetailsSchema.nullish(),
		rate_limit_reached_type: z.unknown().nullish()
	})
	.passthrough()

type UsageResponse = z.infer<typeof UsageResponseSchema>

function durationLabel(seconds: number | undefined, fallback: string): string {
	if (seconds === undefined || seconds === 0) {
		return fallback
	}
	const hours = seconds / 3_600
	if (Number.isInteger(hours) && hours < 24) {
		return `${hours} hour`
	}
	const days = hours / 24
	if (Number.isInteger(days)) {
		return `${days} day`
	}
	return fallback
}

function toWindow(
	id: string,
	scope: string,
	fallback: string,
	window: z.infer<typeof WindowSchema>
): UsageWindow {
	const duration = durationLabel(window.limit_window_seconds, fallback)
	return {
		id,
		kind: 'hard',
		label: scope === 'Codex' ? duration : `${scope} · ${duration}`,
		resetAt: window.reset_at === undefined ? null : new Date(window.reset_at * 1000).toISOString(),
		usedPercent: window.used_percent
	}
}

function appendLimitWindows(
	windows: UsageWindow[],
	prefix: string,
	label: string,
	details: z.infer<typeof LimitDetailsSchema> | null | undefined
): void {
	if (details?.primary_window != null) {
		windows.push(toWindow(`${prefix}:primary`, label, 'primary', details.primary_window))
	}
	if (details?.secondary_window != null) {
		windows.push(toWindow(`${prefix}:secondary`, label, 'secondary', details.secondary_window))
	}
}

function normalizeResponse(accountId: string, body: UsageResponse): UsageSnapshot {
	const windows: UsageWindow[] = []
	appendLimitWindows(windows, 'codex', 'Codex', body.rate_limit)
	for (const additional of body.additional_rate_limits ?? []) {
		appendLimitWindows(
			windows,
			additional.metered_feature,
			additional.limit_name,
			additional.rate_limit
		)
	}
	return {
		accountId,
		hardLimitReached:
			body.rate_limit?.limit_reached === true ||
			body.rate_limit?.allowed === false ||
			body.rate_limit_reached_type != null ||
			(body.additional_rate_limits ?? []).some(
				additional =>
					additional.rate_limit?.limit_reached === true || additional.rate_limit?.allowed === false
			),
		observedAt: new Date().toISOString(),
		provider: 'openai',
		source: 'codexUsageEndpoint',
		windows
	}
}

export async function fetchCodexUsage(input: {
	accountId: string
	credential: CodexAuth
	fetchImplementation?: FetchImplementation
}): Promise<UsageSnapshot> {
	const identity = codexIdentity(input.credential)
	const fetchImplementation = input.fetchImplementation ?? fetch
	const response = await fetchImplementation(usageEndpoint, {
		headers: {
			Authorization: `Bearer ${input.credential.tokens.access_token}`,
			'ChatGPT-Account-Id': identity.accountId,
			'User-Agent': 'codex-cli'
		},
		signal: AbortSignal.timeout(10_000)
	})
	if (response.status === 401) {
		throw new ApplicationError(
			'ACCESS_TOKEN_REJECTED',
			'Codex usage endpoint rejected the access token'
		)
	}
	if (response.status === 429) {
		throw new ApplicationError('USAGE_RATE_LIMITED', 'Codex usage endpoint rate-limited the probe')
	}
	if (!response.ok) {
		throw new ApplicationError(
			'PROVIDER_UNREACHABLE',
			`Codex usage endpoint returned HTTP ${response.status}`
		)
	}
	return normalizeResponse(input.accountId, UsageResponseSchema.parse(await response.json()))
}
