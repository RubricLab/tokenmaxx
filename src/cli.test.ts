import { describe, expect, test } from 'bun:test'
import { stripTerminalNoise } from './cli.ts'

describe('stripTerminalNoise', () => {
	test('terminal chatter never survives into a typed answer', () => {
		expect(stripTerminalNoise('\x1b[B\x1b[Ask-ant-abc123')).toBe('sk-ant-abc123')
		expect(stripTerminalNoise('\x1bP1+r4d73=1b5d\x1b\\sk-proj-xyz')).toBe('sk-proj-xyz')
		expect(stripTerminalNoise('\x1b]0;4:00 on ttys005\x07my key')).toBe('my key')
		expect(stripTerminalNoise('  plain-key-42  ')).toBe('plain-key-42')
	})
})
