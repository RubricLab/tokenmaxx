import { z } from 'zod'
import type { UsageSnapshot, UsageWindow } from '../../domain.ts'
import { ApplicationError } from '../../errors.ts'
import type { FetchImplementation } from '../../http.ts'

const UsageWindowSchema = z
	.object({
		limit_dollars: z.number().nonnegative().nullish(),
		remaining_dollars: z.number().nonnegative().nullish(),
		resets_at: z.union([z.string(), z.number()]).nullish(),
		used_dollars: z.number().nonnegative().nullish(),
		utilization: z.number().min(0)
	})
	.passthrough()

const LimitScopeSchema = z
	.object({
		model: z
			.object({ display_name: z.string().nullish(), id: z.string().nullish() })
			.passthrough()
			.nullish(),
		surface: z
			.union([
				z.string(),
				z.object({ display_name: z.string().nullish(), id: z.string().nullish() }).passthrough()
			])
			.nullish()
	})
	.passthrough()

const LimitSchema = z
	.object({
		group: z.string().nullish(),
		is_active: z.boolean().nullish(),
		kind: z.string().min(1),
		percent: z.number().min(0),
		resets_at: z.union([z.string(), z.number()]).nullish(),
		scope: LimitScopeSchema.nullish(),
		severity: z.string().nullish()
	})
	.passthrough()

const ClaudeUsageResponseSchema = z
	.object({
		five_hour: UsageWindowSchema.nullish(),
		limits: z.array(LimitSchema).nullish(),
		seven_day: UsageWindowSchema.nullish(),
		seven_day_oauth_apps: UsageWindowSchema.nullish(),
		seven_day_opus: UsageWindowSchema.nullish(),
		seven_day_sonnet: UsageWindowSchema.nullish()
	})
	.passthrough()

function resetTimestamp(value: string | number | null | undefined): string | null {
	if (value == null) {
		return null
	}
	const timestamp =
		typeof value === 'number' ? (value > 1_000_000_000_000 ? value : value * 1000) : Date.parse(value)
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function normalizePercent(utilization: number): number {
	const percent = utilization <= 1 ? utilization * 100 : utilization
	return Math.min(100, percent)
}

function normalizeWindow(
	id: string,
	label: string,
	source: z.infer<typeof UsageWindowSchema>
): UsageWindow {
	return {
		id,
		kind:
			id.includes('oauth_apps') || id.includes('extra_usage') || source.limit_dollars != null
				? 'spend'
				: 'hard',
		label,
		resetAt: resetTimestamp(source.resets_at),
		usedPercent: normalizePercent(source.utilization)
	}
}

function limitScopeName(limit: z.infer<typeof LimitSchema>): string | null {
	const surface = limit.scope?.surface
	const surfaceName = typeof surface === 'string' ? surface : surface?.display_name
	return limit.scope?.model?.display_name ?? surfaceName ?? limit.scope?.model?.id ?? null
}

function limitWindow(limit: z.infer<typeof LimitSchema>): UsageWindow {
	const scopeName = limitScopeName(limit)
	const labels: Record<string, string> = {
		session: '5h session',
		weekly_all: '7 day · all models',
		weekly_scoped: `7 day · ${scopeName ?? 'scoped'}`
	}
	const fallbackLabel = limit.kind
		.split('_')
		.filter(part => part.length > 0)
		.map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
		.join(' ')
	return {
		id: scopeName === null ? limit.kind : `${limit.kind}:${scopeName.toLowerCase()}`,
		kind: 'hard',
		label:
			labels[limit.kind] ?? (scopeName === null ? fallbackLabel : `${fallbackLabel} · ${scopeName}`),
		resetAt: resetTimestamp(limit.resets_at),
		usedPercent: Math.min(100, limit.percent)
	}
}

const exhaustedSeverities = new Set(['exceeded', 'blocked', 'at_limit'])

export async function fetchClaudeUsage(input: {
	accountId: string
	accessToken: string
	fetchImplementation?: FetchImplementation
}): Promise<UsageSnapshot> {
	const response = await (input.fetchImplementation ?? fetch)(
		'https://api.anthropic.com/api/oauth/usage',
		{
			headers: {
				Authorization: `Bearer ${input.accessToken}`,
				'anthropic-beta': 'oauth-2025-04-20',
				'Content-Type': 'application/json'
			},
			signal: AbortSignal.timeout(10_000)
		}
	)
	if (response.status === 401) {
		throw new ApplicationError(
			'ACCESS_TOKEN_REJECTED',
			'Claude usage endpoint rejected the access token'
		)
	}
	if (response.status === 429) {
		throw new ApplicationError('USAGE_RATE_LIMITED', 'Claude usage endpoint rate-limited the probe')
	}
	if (!response.ok) {
		throw new ApplicationError(
			'PROVIDER_UNREACHABLE',
			`Claude usage endpoint returned HTTP ${response.status}`
		)
	}
	const body = ClaudeUsageResponseSchema.parse(await response.json())
	const limits = body.limits ?? []
	const windows: UsageWindow[] = limits.map(limitWindow)
	const coveredIds = new Set(windows.map(window => window.id))
	const definitions = [
		['five_hour', '5 hour', 'session', body.five_hour],
		['seven_day', '7 day', 'weekly_all', body.seven_day],
		['seven_day_opus', '7 day · Opus', null, body.seven_day_opus],
		['seven_day_sonnet', '7 day · Sonnet', null, body.seven_day_sonnet],
		['seven_day_oauth_apps', '7 day · OAuth apps', null, body.seven_day_oauth_apps]
	] as const
	for (const [id, label, limitEquivalent, window] of definitions) {
		if (window == null || (limitEquivalent !== null && coveredIds.has(limitEquivalent))) {
			continue
		}
		windows.push(normalizeWindow(id, label, window))
	}
	const knownWindowIds = new Set<string>([...definitions.map(([id]) => id), 'limits'])
	for (const [id, value] of Object.entries(body)) {
		if (knownWindowIds.has(id)) {
			continue
		}
		const additional = UsageWindowSchema.safeParse(value)
		if (additional.success) {
			const label = id
				.split('_')
				.filter(part => part.length > 0)
				.map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
				.join(' ')
			windows.push(normalizeWindow(id, label, additional.data))
		}
	}
	return {
		accountId: input.accountId,
		hardLimitReached:
			windows.some(window => window.kind === 'hard' && window.usedPercent >= 100) ||
			limits.some(
				limit => limit.severity != null && exhaustedSeverities.has(limit.severity.toLowerCase())
			),
		observedAt: new Date().toISOString(),
		provider: 'anthropic',
		source: 'claudeUsageEndpoint',
		windows
	}
}
