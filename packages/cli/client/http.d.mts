export function createCloudHTTPHandler(options: {baseURL: string; publicURL: string; fetch?: typeof globalThis.fetch}): (request: Request) => Promise<Response>;
