import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const TARGETS_FILE = "tau-reference-targets.json";

export type ReferenceTargetStatus = "ADDED" | "MODIFIED" | "DELETED";

export interface ReferenceTarget {
	path: string;
	status: ReferenceTargetStatus;
	applied: boolean;
}

export interface ReferenceTargetsMeta {
	refSha: string | null;
	totalEntriesRaw: number;
}

interface Payload {
	targets: ReferenceTarget[];
	meta: ReferenceTargetsMeta;
}

let cached: Payload | null = null;
let cachedCwd: string | null = null;

function filePath(cwd: string): string {
	return join(resolve(cwd), ".git", TARGETS_FILE);
}

function load(cwd: string): Payload | null {
	const p = filePath(cwd);
	if (!existsSync(p)) return null;
	try {
		const raw = readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw) as Partial<Payload>;
		const targets = Array.isArray(parsed.targets) ? parsed.targets : [];
		const safeTargets: ReferenceTarget[] = [];
		for (const t of targets) {
			if (!t || typeof t.path !== "string" || !t.path) continue;
			if (t.status !== "ADDED" && t.status !== "MODIFIED" && t.status !== "DELETED") continue;
			safeTargets.push({ path: t.path, status: t.status, applied: Boolean(t.applied) });
		}
		const meta: ReferenceTargetsMeta = {
			refSha: typeof parsed.meta?.refSha === "string" ? parsed.meta.refSha : null,
			totalEntriesRaw: typeof parsed.meta?.totalEntriesRaw === "number" ? parsed.meta.totalEntriesRaw : 0,
		};
		return { targets: safeTargets, meta };
	} catch {
		return null;
	}
}

function ensure(cwd: string): Payload | null {
	const r = resolve(cwd);
	if (cached && cachedCwd === r) return cached;
	cached = load(r);
	cachedCwd = r;
	return cached;
}

export function setReferenceTargets(cwd: string, targets: ReferenceTarget[], meta: ReferenceTargetsMeta): void {
	const r = resolve(cwd);
	const payload: Payload = {
		targets: targets
			.filter((t) => t && typeof t.path === "string" && t.path.length > 0)
			.map((t) => ({
				path: t.path.startsWith("./") ? t.path.slice(2) : t.path,
				status: t.status,
				applied: Boolean(t.applied),
			})),
		meta,
	};
	cached = payload;
	cachedCwd = r;
	try {
		const p = filePath(r);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify(payload, null, 2), "utf-8");
	} catch {
		// best-effort
	}
}

export function getReferenceTargets(cwd: string): ReferenceTarget[] {
	const d = ensure(cwd);
	return d ? [...d.targets] : [];
}

export function getReferenceTargetsMeta(cwd: string): ReferenceTargetsMeta | null {
	const d = ensure(cwd);
	return d ? { ...d.meta } : null;
}

export function clearReferenceTargets(cwd: string): void {
	const r = resolve(cwd);
	cached = null;
	cachedCwd = r;
	try {
		const p = filePath(r);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(
			p,
			JSON.stringify({ targets: [], meta: { refSha: null, totalEntriesRaw: 0 } }, null, 2),
			"utf-8",
		);
	} catch {
		// best-effort
	}
}
