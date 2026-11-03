import { bindings, defineConfig, triggers } from "cf/config";

/**
 * Wrangler environments are selected through ctx.mode and the cf --mode flag.
 * @see https://developers.cloudflare.com/workers/wrangler/environments/
 */


export default defineConfig((ctx) => {
	switch (ctx.mode) {
		case "local": {
			return {
				worker: {
					name: "dibs-relay-local",
					compatibilityDate: "2026-08-01",
					entrypoint: "src/index.js",
					workersDev: false,
					previewUrls: false,
					logpush: false,
					observability: {
						enabled: false,
					},
					assets: {
						runWorkerFirst: true,
					},
					// One Durable Object per machine id; it routes frames and stores nothing.
					exports: {
						Machine: { type: "durable-object", storage: "sqlite" },
					},
					env: {
						PAGE_HOST: bindings.text(""),
						MACHINE: bindings.durableObject({
							worker: "dibs-relay-local",
							exportName: "Machine",
						}),
						RL: bindings.rateLimit({
							namespace: "7423",
							simple: {
								limit: 1000,
								period: 60,
							},
						}),
						ASSETS: bindings.assets(),
					},
				},
			};
		}
		default: {
			return {
				worker: {
					name: "dibs-relay",
					compatibilityDate: "2026-08-01",
					entrypoint: "src/index.js",
					workersDev: false,
					previewUrls: false,
					logpush: false,
					observability: {
						enabled: false,
					},
					assets: {
						runWorkerFirst: true,
					},
					// One Durable Object per machine id; it routes frames and stores nothing.
					exports: {
						Machine: { type: "durable-object", storage: "sqlite" },
						// Sign-in code hashes and machine ids for remote MCP, ten minutes at most.
						CodeIndex: { type: "durable-object", storage: "sqlite" },
						// Email hashes, passkey public keys and sealed keyrings (src/accountbook.js).
						Accounts: { type: "durable-object", storage: "sqlite" },
					},
					domains: [
						"app.dibs.cc",
						"mcp.dibs.cc",
					],
					triggers: [
						triggers.fetch({
							pattern: "dibs.cc/app",
							zone: "dibs.cc",
						}),
						triggers.fetch({
							pattern: "dibs.cc/app/*",
							zone: "dibs.cc",
						}),
					],
					env: {
						PAGE_HOST: bindings.text("app.dibs.cc"),
						MCP_HOST: bindings.text("mcp.dibs.cc"),
						MAIL_FROM: bindings.text("no-reply@mail.dibs.cc"),
						// The Turnstile widget on mcp.dibs.cc/email; its secret is TURNSTILE_SECRET.
						TURNSTILE_SITEKEY: bindings.text("0x4AAAAAAFxfl4Oft0B4fWmc"),
						MACHINE: bindings.durableObject({
							worker: "dibs-relay",
							exportName: "Machine",
						}),
						INDEX: bindings.durableObject({
							worker: "dibs-relay",
							exportName: "CodeIndex",
						}),
						ACCOUNTS: bindings.durableObject({
							worker: "dibs-relay",
							exportName: "Accounts",
						}),
						// Sign-in links, from the dibs.cc zone's Email Sending at mail.dibs.cc.
						EMAIL: bindings.sendEmail({
							allowedSenderAddresses: ["no-reply@mail.dibs.cc"],
						}),
						// Account requests per address: signing in takes a handful.
						RLA: bindings.rateLimit({
							namespace: "7425",
							simple: {
								limit: 30,
								period: 60,
							},
						}),
						// MCP requests per address: a client's session makes a few dozen a minute.
						RLM: bindings.rateLimit({
							namespace: "7424",
							simple: {
								limit: 120,
								period: 60,
							},
						}),
						RL: bindings.rateLimit({
							namespace: "7423",
							simple: {
								limit: 20,
								period: 60,
							},
						}),
						ASSETS: bindings.assets(),
					},
				},
			};
		}
	}
});
