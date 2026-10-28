/**
 * @module runner/engine-endpoints
 * @description Reviewed agent-engine endpoint records. Each record keeps the base
 *   URL paired with the auth header NAME its endpoint expects; credential values
 *   are provisioned outside this repository and never enter a submission.
 *
 * @outputs
 *   - `EngineEndpoint` -- the paired endpoint fields carried by a routed job
 *   - `ENGINE_ENDPOINTS` -- the fixed cliproxyapi and Bifrost endpoint records
 */

/** A runner engine endpoint and the name of its credential-bearing request header. */
export interface EngineEndpoint {
	baseUrl: string;
	authHeaderName: string;
}

/** Fixed engine endpoints verified for software-factory issue #283. */
export const ENGINE_ENDPOINTS = {
	cliproxyapi: {
		baseUrl: "https://codex-proxy.example.internal",
		authHeaderName: "Authorization",
	},
	bifrost: {
		baseUrl: "http://10.0.20.158:8080",
		authHeaderName: "x-bf-vk",
	},
} as const satisfies Record<string, EngineEndpoint>;
