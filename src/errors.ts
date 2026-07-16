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

const networkFailurePattern =
	/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENETDOWN|getaddrinfo|timed? ?out|unable to connect|typo in the url|fetch failed|socket hang ?up|dns lookup/i

export function isNetworkFailureText(text: string): boolean {
	return networkFailurePattern.test(text)
}

export function isNetworkFailure(error: unknown): boolean {
	if (error instanceof ApplicationError) {
		switch (error.code) {
			case 'PROVIDER_UNREACHABLE':
			case 'UPSTREAM_UNREACHABLE':
				return true
			default:
				return error.cause !== undefined && isNetworkFailure(error.cause)
		}
	}
	if (error instanceof Error) {
		if (error.name === 'TimeoutError' || error.name === 'ConnectionError') {
			return true
		}
		const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
		return isNetworkFailureText(error.message) || isNetworkFailureText(code)
	}
	return false
}
