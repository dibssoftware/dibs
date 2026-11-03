import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig((ctx) => {
	switch (ctx.mode) {
		case "local": {
			return {
				assetsDirectory: "./public",
			};
		}
		default: {
			return {
				assetsDirectory: "./public",
			};
		}
	}
});
