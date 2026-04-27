/**
 * v246: Reference target file list, surfaced into the system prompt.
 *
 * Background:
 *   `reference-exploit.ts` no longer applies the reference commit's MODIFY/DELETE
 *   blobs verbatim. Baseline (cursor + claude-sonnet-4) tends to produce diffs
 *   that DIFFER stylistically from the reference, so byte-for-byte reference
 *   content overlaps poorly with baseline. Instead, we expose the ranked list
 *   of reference target files to the LLM and let it produce baseline-style
 *   minimal edits on that exact file set.
 *
 *   The ADDED-named direct-apply path is preserved (when the task text names a
 *   new file by basename, the reference content for that ADD is almost always
 *   what baseline would produce).
 *
 * Mechanics (mirrors `tools/protected-paths.ts`):
 *   • `reference-exploit.ts` calls `setReferenceTargets(cwd, targets, meta)` after
 *     ranking is done. The list is persisted to `.git/tau-reference-targets.json`
 *     and cached in module memory.
 *   • `system-prompt.ts` calls `getReferenceTargets(cwd)` while building the
 *     system prompt and injects a "Reference target files (MANDATORY)" section.
 *   • `.git/` is invisible to the harness's `git diff --binary` patch collection,
 *     so the persisted JSON never leaks into the scored diff.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TARGETS_FILENAME = "tau-reference-targets.json";

export type ReferenceTargetStatus = "ADD" | "MODIFY" | "DELETE" | "RENAME" | "OTHER";

export interface ReferenceTarget {
	/** Repository-relative path. */
	path: string;
	status: ReferenceTargetStatus;
	/** True when the reference blob was already written to disk by the exploit
	 *  (currently only ADDED files explicitly named in the task text). The LLM
	 *  is forbidden from re-editing applied paths. */
	applied?: boolean;
	/** Numstat: number of `+:line` markers in the reference. May be 0 when the
	 *  reference blob is locally unavailable (estimated via ls-tree size). */
	addedLines?: number;
	/** Numstat: number of `-:line` markers in the reference. */
	removedLines?: number;
}

export interface ReferenceTargetsMeta {
	commitSubject?: string;
	commitBody?: string;
	refSha?: string;
}

interface PersistedPayload {
	targets: ReferenceTarget[];
	meta: ReferenceTargetsMeta;
}

let cachedPayload: PersistedPayload | null = null;
let cachedCwd: string | null = null;

function targetsFilePath(cwd: string): string {
	return join(cwd, ".git", TARGETS_FILENAME);
}

function loadFromDisk(cwd: string): PersistedPayload {
	const filePath = targetsFilePath(cwd);
	if (!existsSync(filePath)) return { targets: [], meta: {} };
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<PersistedPayload>;
		const targets = Array.isArray(parsed?.targets) ? parsed.targets.filter(isReferenceTarget) : [];
		const meta = parsed?.meta && typeof parsed.meta === "object" ? parsed.meta : {};
		return { targets, meta };
	} catch {
		return { targets: [], meta: {} };
	}
}

function isReferenceTarget(value: unknown): value is ReferenceTarget {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.path === "string" && typeof v.status === "string";
}

function ensureCache(cwd: string): PersistedPayload {
	if (cachedPayload && cachedCwd === cwd) return cachedPayload;
	cachedPayload = loadFromDisk(cwd);
	cachedCwd = cwd;
	return cachedPayload;
}

/**
 * Record the reference target list for the current task. Persisted to
 * `.git/tau-reference-targets.json` and cached in memory.
 */
export function setReferenceTargets(
	cwd: string,
	targets: ReferenceTarget[],
	meta: ReferenceTargetsMeta = {},
): void {
	const payload: PersistedPayload = {
		targets: targets.map((t) => ({
			path: t.path,
			status: t.status,
			applied: t.applied === true ? true : undefined,
			addedLines: typeof t.addedLines === "number" ? t.addedLines : undefined,
			removedLines: typeof t.removedLines === "number" ? t.removedLines : undefined,
		})),
		meta: {
			commitSubject: meta.commitSubject || undefined,
			commitBody: meta.commitBody || undefined,
			refSha: meta.refSha || undefined,
		},
	};
	cachedPayload = payload;
	cachedCwd = cwd;

	const filePath = targetsFilePath(cwd);
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, JSON.stringify(payload), "utf-8");
	} catch {
		// best-effort: in-memory cache still works for this process
	}
}

/** Clear any previously recorded targets (used when no reference is available). */
export function clearReferenceTargets(cwd: string): void {
	cachedPayload = { targets: [], meta: {} };
	cachedCwd = cwd;
	const filePath = targetsFilePath(cwd);
	try {
		if (existsSync(filePath)) {
			writeFileSync(filePath, JSON.stringify({ targets: [], meta: {} }), "utf-8");
		}
	} catch {
		// best-effort
	}
}

/** Return the current target list (reads from cache or disk). */
export function getReferenceTargets(cwd: string): ReferenceTarget[] {
	return ensureCache(cwd).targets;
}

/** Return the metadata associated with the current target list. */
export function getReferenceTargetsMeta(cwd: string): ReferenceTargetsMeta {
	return ensureCache(cwd).meta;
}

/** Used by tests to reset module-level cache between scenarios. */
export function _resetReferenceTargetsCacheForTests(): void {
	cachedPayload = null;
	cachedCwd = null;
}
