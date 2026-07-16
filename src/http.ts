export type FetchImplementation = (
  input: string | URL | Request,
  initialization?: RequestInit,
) => Promise<Response>;
