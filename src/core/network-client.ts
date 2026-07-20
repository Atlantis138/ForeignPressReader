/**
 * Platform-neutral boundary for outbound HTTP(S) requests.
 *
 * Desktop injects an Electron implementation backed by `net.fetch`, while a
 * future Tauri client can provide its own adapter without changing services.
 */
export interface NetworkClient {
  fetch(input: string, init?: RequestInit): Promise<Response>
}
