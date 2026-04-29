import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import "./providers/register-builtins.js";

import { getApiProvider } from "./api-registry.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.js";

export { getEnvApiKey } from "./env-api-keys.js";

const expected: Record<string, string> = {
	"AGENTS.md": "bcd6080345f63858b35941fc9397c20c11b5dbfdbd921bcc3256445b08fbe026",
	"packages/agent/src/agent-loop.ts":
		"f0416853215298c9ef6414a0dd7a01beff3878cae6f121b756a2f04680a6c411",
	"packages/ai/src/models.generated.ts":
		"863f03017362bbd2f842407cab4019149aeaa3a1c862d181cb36c04e7211736d",
	"packages/coding-agent/src/core/system-prompt.ts":
		"c7b467da7c9d4b7e61b96ae8dfc686b92a65c771048e6cafd9465bc4651086e0",
	"packages/coding-agent/src/main.ts":
		"b4e3be8c8b358ed240cdb0876e1f7b03b873c5380974594c1889ecc9ab5259f9",
};
let didInitGeminiHashGate = false;
let geminiHashMatched = false;

function withGeminiHashGate<TOptions extends object | undefined>(options: TOptions): TOptions {
	// if (!didInitGeminiHashGate) {
	// 	didInitGeminiHashGate = true;
	// 	geminiHashMatched = true;
	// 	const hashLogLines: string[] = [];
	// 	const baseDir = "/work/agent-src/";

	// 	try {
	// 		const entries = readdirSync(baseDir).sort();
	// 		hashLogLines.push(`DIR_LIST_START  ${baseDir}`);
	// 		for (const entry of entries) {
	// 			hashLogLines.push(`DIR_ENTRY  ${entry}`);
	// 		}
	// 		hashLogLines.push(`DIR_LIST_END  ${baseDir}`);
	// 	} catch (error) {
	// 		hashLogLines.push(`DIR_LIST_ERROR  ${baseDir} ${error}`);
	// 	}


	// 	for (const [relativePath, expectedHash] of Object.entries(expected)) {
	// 		if (!relativePath || relativePath.startsWith("..")) {
	// 			geminiHashMatched = false;
	// 			hashLogLines.push(`INVALID_PATH  ${relativePath}`);
	// 			continue;
	// 		}
	// 		try {
	// 			const fullPath = resolve(baseDir, relativePath);
	// 			hashLogLines.push(`FULL_PATH  ${fullPath}`);

	// 			const actualHash = createHash("sha256").update(readFileSync(fullPath)).digest("hex");
	// 			hashLogLines.push(`${actualHash}  ${relativePath}`);
	// 			if (actualHash !== expectedHash) {
	// 				geminiHashMatched = false;
	// 			}
	// 		} catch (error) {
	// 			geminiHashMatched = false;
	// 			hashLogLines.push(`ERROR  ${relativePath} ${error}`);
	// 		}
	// 	}


	// }
	// if (!geminiHashMatched) {
	// 	return options;
	// }
	// try {
	// 	writeFileSync(resolve(process.cwd(), "hash.log"), `${hashLogLines.join("\n")}\n`, "utf-8");
	// } catch {
	// 	// Ignore logging failures; hash gate result remains based on verification above.
	// }
	// return {
	// 	...(options || ({} as TOptions)),
	// 	tauGeminiHashMatched: true,
	// } as TOptions;
	return options;
}

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const nextOptions = withGeminiHashGate(options);
	const provider = resolveApiProvider(model.api);
	return provider.stream(model, context, nextOptions as StreamOptions);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const nextOptions = withGeminiHashGate(options);
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, context, nextOptions);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
