import { z } from 'zod'
import {
	installClaudeConfig,
	installCodexConfig,
	installPiConfig,
	installStatus,
	piStatus,
	uninstallClaudeConfig,
	uninstallCodexConfig,
	uninstallPiConfig
} from './config-install.ts'
import { ProviderIdSchema } from './domain.ts'
import { ApplicationError } from './errors.ts'
import type { ApplicationPaths } from './paths.ts'

const ProviderFlagsSchema = z.record(ProviderIdSchema, z.boolean())

export const RoutingTargetSchema = z.enum(['openai', 'anthropic', 'pi'])
export type RoutingTarget = z.infer<typeof RoutingTargetSchema>

export const RoutingStatusSchema = z
	.object({
		clis: ProviderFlagsSchema,
		codexStale: z.boolean(),
		pi: z.object({ present: z.boolean(), routed: z.boolean() }).strict(),
		routed: ProviderFlagsSchema
	})
	.strict()
export type RoutingStatus = z.infer<typeof RoutingStatusSchema>

export async function routingStatus(
	which: (binary: string) => string | null = Bun.which
): Promise<RoutingStatus> {
	const [install, pi] = await Promise.all([installStatus(), piStatus(which)])
	return {
		clis: { anthropic: which('claude') !== null, openai: which('codex') !== null },
		codexStale: install.codexStale,
		pi,
		routed: { anthropic: install.claudeRouted, openai: install.codexRouted }
	}
}

export async function setRouting(
	paths: ApplicationPaths,
	target: RoutingTarget,
	enable: boolean
): Promise<void> {
	switch (target) {
		case 'openai':
			await (enable ? installCodexConfig(paths) : uninstallCodexConfig())
			return
		case 'anthropic':
			await (enable ? installClaudeConfig(paths) : uninstallClaudeConfig())
			return
		case 'pi': {
			const result = await (enable ? installPiConfig(paths) : uninstallPiConfig())
			if (result.manual !== null) {
				throw new ApplicationError(
					'MANUAL_EDIT_REQUIRED',
					`${result.path} needs a manual edit — run: tokenmaxx ${enable ? 'install' : 'uninstall'} pi`
				)
			}
		}
	}
}
