export class ApplicationError extends Error {
	public readonly code: string

	public constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'ApplicationError'
		this.code = code
	}
}

export function errorMessage(error: unknown): string {
	switch (true) {
		case error instanceof Error:
			return error.message
		case typeof error === 'string':
			return error
		default:
			return 'Unknown failure'
	}
}
