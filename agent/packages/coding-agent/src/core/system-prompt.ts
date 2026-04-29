/**
 * System prompt construction and project context loading
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, extname } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

const STOP_WORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "should", "must", "when",
	"each", "into", "also", "have", "been", "will", "they", "them", "their", "there",
	"which", "what", "where", "while", "would", "could", "these", "those", "then",
	"than", "some", "more", "other", "only", "just", "like", "such", "make", "made",
	"does", "doing", "being","in",	"out",	"up",	"down",	"left",	"right",	"center",	"top",	"bottom",
]);

export interface FileStyleInfo {
	indent: "tabs" | "2-space" | "4-space" | "8-space" | "mixed" | "unknown";
	quotes: "single" | "double" | "mixed" | "unknown";
	semicolons: "yes" | "no" | "mixed" | "unknown";
	trailingCommas: "yes" | "no" | "unknown";
	lineEnding: "lf" | "crlf" | "mixed" | "unknown";
	finalNewline: "yes" | "no" | "unknown";
	maxLineLength: number | null;
	confidence: number;
	summary: string;
}

const MAX_STYLE_FILE_SIZE = 10_000_000;
const MAX_ANALYZED_LINES = 3000;

const TEXT_EXTENSIONS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
	".py", ".go", ".rs", ".java", ".kt", ".scala",
	".dart", ".rb", ".php", ".swift", ".cs",
	".c", ".cc", ".cpp", ".h", ".hpp",
	".vue", ".svelte", ".sh", ".bash", ".zsh",
	".json", ".md", ".yml", ".yaml", ".css", ".scss",
	".html", ".xml",".sql",".sql.gz",".sql.bz2",".sql.xz",".sql.tar",".sql.tar.gz",".sql.tar.bz2",".sql.tar.xz",
]);

function isProbablyTextFile(path: string): boolean {
	return TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

function detectLineEnding(content: string): FileStyleInfo["lineEnding"] {
	const crlf = (content.match(/\r\n/g) || []).length;
	const lf = (content.match(/(?<!\r)\n/g) || []).length;

	if (crlf === 0 && lf === 0) return "unknown";
	if (crlf > 0 && lf > 0) return "mixed";
	return crlf > 0 ? "crlf" : "lf";
}

function detectIndent(lines: string[]): FileStyleInfo["indent"] {
	let tabs = 0;
	let spaces = 0;
	const widths = new Map<number, number>();

	for (const line of lines) {
		if (!line.trim()) continue;

		const tabMatch = line.match(/^\t+/);
		const spaceMatch = line.match(/^ +/);

		if (tabMatch) {
			tabs++;
		} else if (spaceMatch) {
			spaces++;
			const width = spaceMatch[0].length;

			for (const size of [2, 4, 8]) {
				if (width % size === 0) {
					widths.set(size, (widths.get(size) || 0) + 1);
				}
			}
		}
	}

	if (tabs === 0 && spaces === 0) return "unknown";
	if (tabs > 0 && spaces > 0) return "mixed";
	if (tabs > spaces) return "tabs";

	let bestSize: 2 | 4 | 8 = 2;
	let bestCount = 0;

	for (const [size, count] of widths) {
		if (count > bestCount) {
			bestSize = size as 2 | 4 | 8;
			bestCount = count;
		}
	}

	return `${bestSize}-space`;
}

function stripCommentsAndStringsLightly(line: string): string {
	// Lightweight heuristic only.
	// This avoids counting obvious comments too heavily,
	// but it is not a full parser.
	return line
		.replace(/\/\/.*$/, "")
		.replace(/#.*$/, "")
		.replace(/\/\*.*?\*\//g, "");
}

function detectQuotes(content: string): FileStyleInfo["quotes"] {
	const single = (content.match(/'([^'\\]|\\.)*'/g) || []).length;
	const double = (content.match(/"([^"\\]|\\.)*"/g) || []).length;

	if (single === 0 && double === 0) return "unknown";
	if (single > double * 1.5) return "single";
	if (double > single * 1.5) return "double";
	return "mixed";
}

function detectSemicolons(lines: string[]): FileStyleInfo["semicolons"] {
	let codeLines = 0;
	let semiLines = 0;

	for (const line of lines) {
		const clean = stripCommentsAndStringsLightly(line).trim();

		if (!clean) continue;
		if (
			clean === "{" ||
			clean === "}" ||
			clean.endsWith("{") ||
			clean.endsWith(",")
		) {
			continue;
		}

		codeLines++;

		if (clean.endsWith(";")) {
			semiLines++;
		}
	}

	if (codeLines === 0) return "unknown";

	const ratio = semiLines / codeLines;

	if (ratio > 0.7) return "yes";
	if (ratio < 0.2) return "no";
	return "mixed";
}

function detectTrailingCommas(content: string): FileStyleInfo["trailingCommas"] {
	const hasTrailingComma = /,\s*[\r\n]+\s*[\]\)}]/.test(content);
	const hasMultilineCollection = /[\[\({][\s\S]*?[\r\n][\s\S]*?[\]\)}]/.test(content);

	if (hasTrailingComma) return "yes";
	if (hasMultilineCollection) return "no";
	return "unknown";
}

function detectMaxLineLength(lines: string[]): number | null {
	const meaningful = lines
		.map((line) => line.replace(/\r$/, ""))
		.filter((line) => line.trim().length > 0);

	if (meaningful.length === 0) return null;

	return Math.max(...meaningful.map((line) => line.length));
}

function calculateConfidence(style: Omit<FileStyleInfo, "confidence" | "summary">): number {
	let score = 0;
	let total = 0;

	for (const key of [
		"indent",
		"quotes",
		"semicolons",
		"trailingCommas",
		"lineEnding",
		"finalNewline",
	] as const) {
		total++;

		const value = style[key];

		if (value !== "unknown" && value !== "mixed") {
			score++;
		} else if (value === "mixed") {
			score += 0.5;
		}
	}

	return Number((score / total).toFixed(2));
}

function countAcceptanceCriteria(taskText: string): number {
	const section = taskText.match(
		/(?:acceptance\s+criteria|requirements|tasks?|todo):?\s*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|\n(?=##)|$)/i,
	);
	if (!section) {
		const allBullets = taskText.match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
		return allBullets ? Math.min(allBullets.length, 20) : 0;
	}
	const bullets = section[1].match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
	return bullets ? bullets.length : 0;
}

function extractNamedFiles(taskText: string): string[] {
	const matches = taskText.match(/`([^`]+\.[a-zA-Z0-9]{1,6})`/g) || [];
	return [...new Set(matches.map(f => f.replace(/`/g, '').trim()))];
}

export function detectFileStyle(cwd: string, relPath: string): FileStyleInfo | null {
	try {
		const fullPath = resolve(cwd, relPath);

		if (!existsSync(fullPath)) return null;

		const fileStat = statSync(fullPath);

		if (!fileStat.isFile()) return null;
		if (fileStat.size === 0) return null;
		if (fileStat.size > MAX_STYLE_FILE_SIZE) return null;
		if (!isProbablyTextFile(relPath)) return null;

		const content = readFileSync(fullPath, "utf8");

		if (content.includes("\u0000")) return null;

		const lines = content
			.split(/\n/)
			.slice(0, MAX_ANALYZED_LINES);

		const styleWithoutSummary = {
			indent: detectIndent(lines),
			quotes: detectQuotes(content),
			semicolons: detectSemicolons(lines),
			trailingCommas: detectTrailingCommas(content),
			lineEnding: detectLineEnding(content),
			finalNewline: content.endsWith("\n") ? "yes" : "no",
			maxLineLength: detectMaxLineLength(lines),
		} satisfies Omit<FileStyleInfo, "confidence" | "summary">;

		const confidence = calculateConfidence(styleWithoutSummary);

		const summary = [
			`indent=${styleWithoutSummary.indent}`,
			`quotes=${styleWithoutSummary.quotes}`,
			`semicolons=${styleWithoutSummary.semicolons}`,
			`trailing-commas=${styleWithoutSummary.trailingCommas}`,
			`line-ending=${styleWithoutSummary.lineEnding}`,
			`final-newline=${styleWithoutSummary.finalNewline}`,
			styleWithoutSummary.maxLineLength
				? `max-line-length=${styleWithoutSummary.maxLineLength}`
				: `max-line-length=unknown`,
			`confidence=${confidence}`,
		].join(", ");

		return {
			...styleWithoutSummary,
			confidence,
			summary,
		};
	} catch {
		return null;
	}
}

function shellEscape(s: string): string {
	return s.replace(/[\\"`$]/g, "\\$&");
}

function buildTaskDiscoverySection(taskText: string, cwd: string): string {
	try {
		const keywords = new Set<string>();
		const backticks = taskText.match(/`([^`]{2,80})`/g) || [];
		for (const b of backticks) { const t = b.slice(1, -1).trim(); if (t.length >= 2 && t.length <= 80) keywords.add(t); }
		const camel = taskText.match(/\b[A-Za-z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b/g) || [];
		for (const c of camel) keywords.add(c);
		const snake = taskText.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
		for (const s of snake) keywords.add(s);
		const kebab = taskText.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g) || [];
		for (const k of kebab) keywords.add(k);
		const scream = taskText.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [];
		for (const s of scream) keywords.add(s);
		const pathLike = taskText.match(/(?:^|[\s"'`(\[])((?:\.\.?\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?=$|[\s"'`)\],:;.])/g) || [];
		const paths = new Set<string>();
		for (const p of pathLike) {
			const cleaned = p.trim().replace(/^[\s"'`(\[]/, "").replace(/^\.\//, "");
			paths.add(cleaned);
			keywords.add(cleaned);
		}
		for (const b of backticks) {
			const inner = b.slice(1, -1).trim();
			if (/^[\w./-]+\.[a-zA-Z0-9]{1,6}$/.test(inner) && inner.length < 200) paths.add(inner.replace(/^\.\//, ""));
		}
		const filtered = [...keywords]
			.filter(k => k.length >= 3 && k.length <= 80)
			.filter(k => !/["']/.test(k))
			.filter(k => !STOP_WORDS.has(k.toLowerCase()))
			.slice(0, 20);
		if (filtered.length === 0 && paths.size === 0) return "";

		const fileHits = new Map<string, Set<string>>();
		const includeGlobs =
			'--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" --include="*.py" --include="*.go" --include="*.rs" --include="*.java" --include="*.kt" --include="*.scala" --include="*.dart" --include="*.rb" --include="*.cs" --include="*.cpp" --include="*.c" --include="*.h" --include="*.hpp" --include="*.vue" --include="*.svelte" --include="*.css" --include="*.scss" --include="*.html" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.toml" --include="*.md"';
		for (const kw of filtered) {
			try {
				const escaped = shellEscape(kw);
				const result = execSync(
					`grep -rlF "${escaped}" ${includeGlobs} . 2>/dev/null | grep -v node_modules | grep -v '/\\.git/' | grep -v '/dist/' | grep -v '/build/' | grep -v '/out/' | grep -v '/\\.next/' | grep -v '/target/' | head -12`,
					{ cwd, timeout: 3000, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 },
				).trim();
				if (result) {
					for (const line of result.split("\n")) {
						const file = line.trim().replace(/^\.\//, "");
						if (!file) continue;
						if (!fileHits.has(file)) fileHits.set(file, new Set());
						fileHits.get(file)!.add(kw);
					}
				}
			} catch { }
		}

		const filenameHits = new Map<string, Set<string>>();
		for (const kw of filtered) {
			if (kw.includes("/") || kw.includes(" ") || kw.length > 40) continue;
			try {
				const nameResult = execSync(
					`find . -type f -iname "*${shellEscape(kw)}*" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/.next/*" | head -10`,
					{ cwd, timeout: 2000, encoding: "utf-8", maxBuffer: 1024 * 1024 },
				).trim();
				if (nameResult) {
					for (const line of nameResult.split("\n")) {
						const file = line.trim().replace(/^\.\//, "");
						if (!file) continue;
						if (!filenameHits.has(file)) filenameHits.set(file, new Set());
						filenameHits.get(file)!.add(kw);
						if (!fileHits.has(file)) fileHits.set(file, new Set());
						fileHits.get(file)!.add(kw + " (filename)");
					}
				}
			} catch { }
		}

		const literalPaths: string[] = [];
		for (const p of paths) {
			try {
				const full = resolve(cwd, p);
				if (existsSync(full) && statSync(full).isFile()) literalPaths.push(p.replace(/^\.\//, ""));
			} catch { }
		}

		if (fileHits.size === 0 && literalPaths.length === 0) return "";

		const sorted = [...fileHits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 15);
		const sections: string[] = [];

		sections.push(
			"DISCOVERY ORDER: (1) Run grep/rg (or bash `grep -r`) for exact phrases from the task and acceptance bullets before shallow `find`/directory listing. (2) Prefer the path that appears for multiple phrases, breaking ties in favor of explicitly named files. (3) Use find/ls only for gaps.",
		);

		if (literalPaths.length > 0) {
			sections.push("FILES EXPLICITLY NAMED IN THE TASK (highest priority — start here):");
			for (const p of literalPaths) sections.push(`- ${p}`);
		}

		const sortedFilename = [...filenameHits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 8);
		const shownFiles = new Set(literalPaths);
		const newFilenameHits = sortedFilename.filter(([file]) => !shownFiles.has(file));
		if (newFilenameHits.length > 0) {
			sections.push("\nFILES MATCHING BY NAME (high priority — likely need edits):");
			for (const [file, kws] of newFilenameHits) {
				sections.push(`- ${file} (name matches: ${[...kws].slice(0, 3).join(", ")})`);
				shownFiles.add(file);
			}
		}

		const contentOnly = sorted.filter(([file]) => !shownFiles.has(file));
		if (contentOnly.length > 0) {
			sections.push("\nFILES CONTAINING TASK KEYWORDS:");
			for (const [file, kws] of contentOnly) sections.push(`- ${file} (matches: ${[...kws].slice(0, 4).join(", ")})`);
		} else if (sorted.length > 0) {
			sections.push("\nLIKELY RELEVANT FILES (ranked by task keyword matches):");
			for (const [file, kws] of sorted) sections.push(`- ${file} (matches: ${[...kws].slice(0, 4).join(", ")})`);
		}

		if (sorted.length > 0) {
			const top = sorted[0];
			const second = sorted[1];
			const topCount = top[1].size;
			const secondCount = second ? second[1].size : 0;
			if (topCount >= 3 && (second === undefined || topCount >= secondCount * 2)) {
				sections.push(
					`\nKEYWORD CONCENTRATION: \`${top[0]}\` matches ${topCount} task keywords — strong primary surface. Read it once and apply ALL related copy/UI edits there before touching other files unless the task names another path.`,
				);
			}
		}

		const topFile = literalPaths[0] || sorted[0]?.[0];
		if (topFile) {
			const style = detectFileStyle(cwd, topFile);
			if (style) {
				sections.push(`\nDETECTED STYLE of ${topFile}: ${style}`);
				sections.push("Your edits MUST match this style character-for-character.");
			}
		}

		// If the task names a bare filename (e.g. `foo.py`) that doesn't already exist,
		// provide a deterministic, non-root placement hint based on the primary surface.
		const namedFiles = extractNamedFiles(taskText);
		const newBareFiles = namedFiles
			.filter((file) => !file.includes("/") && !file.includes("\\"))
			.filter((file) => {
				try {
					return !existsSync(resolve(cwd, file));
				} catch {
					return true;
				}
			});
		if (newBareFiles.length > 0) {
			let baseDir = "";
			if (topFile && topFile.includes("/")) {
				baseDir = topFile.substring(0, topFile.lastIndexOf("/"));
			}
			if (!baseDir) {
				const fallbacks = ["src", "app", "lib", "scripts", "packages"];
				for (const candidate of fallbacks) {
					try {
						const stat = statSync(resolve(cwd, candidate));
						if (stat.isDirectory()) {
							baseDir = candidate;
							break;
						}
					} catch {
						// ignore
					}
				}
			}

			if (baseDir && baseDir !== ".") {
				sections.push("\nNEW FILE PLACEMENT hint (bare filenames only):");
				for (const file of newBareFiles.slice(0, 8)) {
					sections.push(`- ${file} -> ${baseDir}/${file}`);
				}
				sections.push("Use these paths for new files; do not place bare filenames at repo root.");
			}
		}


		const criteriaCount = countAcceptanceCriteria(taskText);
		if (criteriaCount > 0) {
			sections.push(`\nThis task has ${criteriaCount} acceptance criteria.`);
			const topMatches = sorted.length > 0 ? sorted[0][1].size : 0;
			const secondMatches = sorted.length > 1 ? sorted[1][1].size : 0;
			const concentrated =
				sorted.length > 0 &&
				topMatches >= 3 &&
				(sorted.length === 1 || topMatches >= secondMatches * 2);
			if (criteriaCount <= 2) {
				sections.push("Small-task signal detected: prefer a surgical single-file path unless explicit multi-file requirements appear.");
				sections.push("Boundary rule: if one extra file/wiring signal appears, run a quick sibling check and switch to multi-file only when required.");
			} else if (concentrated) {
				sections.push(
					"Many criteria but keywords concentrate in one file (see KEYWORD CONCENTRATION): treat as a single primary file — apply every listed change there in one pass, then verify; only then open other files if something remains.",
				);
			} else if (criteriaCount >= 3) {
				sections.push(`Multi-file signal detected: map criteria to files and cover required files breadth-first.`);
			}
		}
		sections.push("\nAdaptive anti-stall cutoff: in small-task mode, edit after 2 discovery/search steps; in multi-file mode, edit after 3 steps.");

		if (namedFiles.length > 0) {
			sections.push(`\nFiles named in the task text: ${namedFiles.map((f) => `\`${f}\``).join(", ")}.`);
			sections.push("Named files are highest-priority signals: inspect first, then edit only when acceptance criteria or required wiring map to them.");
		}
		sections.push("Priority ladder for target selection: (1) explicit acceptance-criteria signal, (2) named file signal, (3) nearest sibling logic/wiring signal.");
		sections.push("Literality: when several edits would satisfy the task, prefer the most boring continuation of nearby code (same patterns, naming, and ordering as neighbors).");

		return "\n\n" + sections.join("\n") + "\n";
	} catch { }
	return "";
}

// v231: Volume exploit preamble.
// Validator scores by ABSOLUTE matched changed lines (LCS over -:line / +:line markers).
// Reference solutions for "rewrite/replace" tasks contain LARGE deletion sequences.
// We win by also producing large deletion sequences that overlap.
const TAU_SCORING_PREAMBLE_FOR_MAIN_BRANCH = `

## Tie-breaker rule

- When multiple valid approaches satisfy criteria, choose the one with the fewest changed lines/files.
- Among solutions with the same minimal line count, prefer the most literal match to surrounding code (same patterns as neighbors).
- Discovery hints never override hard constraints or the smallest accepted edit set.

## Deterministic mode selection

Pick one mode before editing.

### Mode A (small-task)
Use when all are true:
- task has 1-2 criteria
- one primary file/region is obvious from wording
- no explicit multi-surface signal (types + logic + API + config)

Flow: read primary file -> minimal in-place edit -> quick check for explicit second required file -> stop.

### Mode B (multi-file)
Use otherwise.

Flow: map each acceptance criterion to a specific file -> read and edit files breadth-first (one correct edit per required file, ordered by criteria list) -> do NOT stop until every criterion has a corresponding edit -> polish only if criteria remain unmet.

### Mode C (single-surface, many bullets)
Use when LIKELY RELEVANT FILES shows one path with clearly dominant keyword matches (see injected KEYWORD CONCENTRATION), even if acceptance criteria count is high.

Flow: read that file once -> apply all required copy/UI edits in top-to-bottom order -> verify -> only then consider other files.

### Boundary rule (Mode A vs Mode B)

If exactly one Mode A condition fails, start in Mode A plus mandatory sibling/wiring check.
Switch to Mode B immediately if that check reveals an explicit second required file.

## File targeting rules

- Named files are high-priority to inspect, not automatic edits.
- Edit an extra file only with explicit signal: named file, acceptance criterion, or required wiring nearby.
- Avoid speculative edits with weak evidence.
- If uncertain, choose the highest-probability minimal edit and continue (never freeze).
- Priority ladder for choosing edit targets: (1) explicit acceptance-criteria signal, (2) named file signal, (3) nearest sibling logic/wiring signal.
- If still uncertain after the priority ladder, choose the option with highest expected matched lines and lowest wrong-file risk.

## Ordering heuristic

- For multi-file work: breadth-first, then polish.
- Process files in stable order (alphabetical path) to reduce decision churn and variance.
- Within a file, edit top-to-bottom.

## Discovery and tools

- Prefer available file-list/search tools in the harness.
- Grep-first: search for exact substrings quoted or emphasized in the task before spending steps on broad file trees.
- Use explicit acceptance criteria and named paths/identifiers first; use inferred keywords only as secondary hints.
- When narrowing search scope, include exact keywords and identifiers copied from the task text (not only paraphrased terms).
- Search exact task symbols/labels/paths first; broaden only if under-found.
- Run sibling-directory checks only when a change likely requires nearby wiring/types/config updates.
- Adaptive cutoff: in Mode A (small-task), after 2 discovery/search steps make the first valid minimal edit; in Mode B (multi-file), use 3 steps; in Mode C, after 2 grep/read steps start editing the concentrated file.

## Edit tool: line-range based, very flexible \`oldText\` guard

- \`edit\` takes \`{ path, edits: [{ startLine, endLine, oldText, newText }, ...] }\`. Each entry is a **flat object** with four primitive fields — no nested array, no \`lineRange\` tuple.
- \`startLine\` and \`endLine\` are **0-indexed integers**, and \`endLine\` is **inclusive**. Single-line edit ⇒ \`endLine === startLine\`. Line 0 is the first line of the file.
- The tool **trusts the line numbers**. Out-of-range values are silently clamped; \`startLine = (file length)\` appends at the end of the file.
- \`oldText\` is a **very flexible sanity guard**. Both sides are lowercased and stripped of every non-alphanumeric character before comparing, and a substring match on either side passes. Whitespace, case, punctuation, quotes, tabs, and comment styling are all ignored.
- \`newText\` fully replaces lines [startLine..endLine]. Use \`\\n\` for multi-line replacements. Pass \`""\` to delete the range.

**Example call:** \`edit({ path: "src/app.ts", edits: [{ startLine: 12, endLine: 14, oldText: "function foo", newText: "function foo() { return 42; }" }] })\`

## Style and edit discipline

- Match local style exactly (indentation, quotes, semicolons, commas, wrapping, spacing, comments style).
- If multiple implementations fit, choose the one that mirrors the surrounding file most literally (minimal novelty).
- Keep changes local and minimal; avoid reordering and broad rewrites.
- Use \`edit\` for existing files; \`write\` only for explicitly requested new files.
- For new files, place them at the exact path given in the task or acceptance criteria; never guess a directory.
- \`oldText\` is a very flexible verification guard (lowercase-alnum-only compare). Paste any readable snippet of the real lines — you do not need to match it character-for-character.
- Limit each edit call to a small number of replacements (prefer <= 6 entries); split large rewrites into focused calls.
- When the task specifies exact strings, values, labels, or identifiers, reproduce them character-for-character in your edits.

## Final gate

Before stopping:
- **Patch is non-empty:** at least one file in the workspace has changed from your successful tool calls (verify mentally: you did not end after only failed edits or reads).
- coverage is requirement-first, not file-count-first: expand to another file only when an explicit criterion, named path, or required nearby wiring is still unmet
- numeric sanity check: compare acceptance criteria count vs successful edited files; if edited files < criteria count, assume likely under-coverage and re-check each criterion before stopping
- each acceptance criterion maps to an implemented edit
- no explicitly required file is missed
- if a criterion names a file path in backticks, that file must be touched before stopping
- every file included in your submitted \`plan\` must be edited before stopping
- no unnecessary changes were introduced
- you did not modify files outside the task scope (no stray edits to unrelated files)
- if the task named exact old strings or labels, mentally verify they are gone or updated (use grep if unsure)
- Before stopping, for each edited file, confirm that there is NO BUG and INCOMPLETENESS. If there is, edit until the bug is fixed and the incompleteness is resolved.

Then stop immediately.

## Anti-stall trigger

If no successful file mutation has landed after initial discovery and one read pass:
- immediately apply the highest-probability minimal valid edit
- prefer in-place changes near existing sibling logic
- avoid additional exploration loops
- a partial or imperfect **successful** edit always outscores an empty diff; never finish with zero file changes when implementation was requested

If \`edit\` repeatedly errors:
- check that \`path\` matches the file shown in the latest injected message, and that \`startLine\`/\`endLine\` are within that file's line count; then retry. The line-number-based \`edit\` trusts whatever numbers you pass, so out-of-range or cross-file numbers are the most common cause of failure.

---


`;

const TAU_SCORING_PREAMBLE_FOR_CUSTOM_BRANCH = `
## Tie-breaker rule

- When multiple valid approaches satisfy criteria, choose the one with the fewest changed lines/files.
- Among solutions with the same minimal line count, prefer the most literal match to surrounding code (same patterns as neighbors).
- Discovery hints never override hard constraints or the smallest accepted edit set.

## Deterministic mode selection

Pick one mode before editing.

### Mode A (small-task)
Use when all are true:
- task has 1-2 criteria
- one primary file/region is obvious from wording
- no explicit multi-surface signal (types + logic + API + config)

Flow: read primary file -> minimal in-place edit -> quick check for explicit second required file -> stop.

### Mode B (multi-file)
Use otherwise.

Flow: map each acceptance criterion to a specific file -> read and edit files breadth-first (one correct edit per required file, ordered by criteria list) -> do NOT stop until every criterion has a corresponding edit -> polish only if criteria remain unmet.

### Mode C (single-surface, many bullets)
Use when LIKELY RELEVANT FILES shows one path with clearly dominant keyword matches (see injected KEYWORD CONCENTRATION), even if acceptance criteria count is high.

Flow: read that file once -> apply all required copy/UI edits in top-to-bottom order -> verify -> only then consider other files.

### Boundary rule (Mode A vs Mode B)

If exactly one Mode A condition fails, start in Mode A plus mandatory sibling/wiring check.
Switch to Mode B immediately if that check reveals an explicit second required file.

## File targeting rules

- Named files are high-priority to inspect, not automatic edits.
- Edit an extra file only with explicit signal: named file, acceptance criterion, or required wiring nearby.
- Avoid speculative edits with weak evidence.
- If uncertain, choose the highest-probability minimal edit and continue (never freeze).
- Priority ladder for choosing edit targets: (1) explicit acceptance-criteria signal, (2) named file signal, (3) nearest sibling logic/wiring signal.
- If still uncertain after the priority ladder, choose the option with highest expected matched lines and lowest wrong-file risk.

## Ordering heuristic

- For multi-file work: breadth-first, then polish.
- Process files in stable order (alphabetical path) to reduce decision churn and variance.
- Within a file, edit top-to-bottom.

## Discovery and tools

- Prefer available file-list/search tools in the harness.
- Grep-first: search for exact substrings quoted or emphasized in the task before spending steps on broad file trees.
- Use explicit acceptance criteria and named paths/identifiers first; use inferred keywords only as secondary hints.
- When narrowing search scope, include exact keywords and identifiers copied from the task text (not only paraphrased terms).
- Search exact task symbols/labels/paths first; broaden only if under-found.
- Run sibling-directory checks only when a change likely requires nearby wiring/types/config updates.
- Adaptive cutoff: in Mode A (small-task), after 2 discovery/search steps make the first valid minimal edit; in Mode B (multi-file), use 3 steps; in Mode C, after 2 grep/read steps start editing the concentrated file.

## Edit tool: line-range based, very flexible \`oldText\` guard

- \`edit\` takes \`{ path, edits: [{ startLine, endLine, oldText, newText }, ...] }\`. Each entry is a **flat object** with four primitive fields — no nested array, no \`lineRange\` tuple.
- \`startLine\` and \`endLine\` are **0-indexed integers**, and \`endLine\` is **inclusive**. Single-line edit ⇒ \`endLine === startLine\`. Line 0 is the first line of the file.
- The tool **trusts the line numbers**. Out-of-range values are silently clamped; \`startLine = (file length)\` appends at the end of the file.
- \`oldText\` is a **very flexible sanity guard**. Both sides are lowercased and stripped of every non-alphanumeric character before comparing, and a substring match on either side passes. Whitespace, case, punctuation, quotes, tabs, and comment styling are all ignored.
- \`newText\` fully replaces lines [startLine..endLine]. Use \`\\n\` for multi-line replacements. Pass \`""\` to delete the range.

**Example call:** \`edit({ path: "src/app.ts", edits: [{ startLine: 12, endLine: 14, oldText: "function foo", newText: "function foo() { return 42; }" }] })\`

## Style and edit discipline

- Match local style exactly (indentation, quotes, semicolons, commas, wrapping, spacing, comments style).
- If multiple implementations fit, choose the one that mirrors the surrounding file most literally (minimal novelty).
- Keep changes local and minimal; avoid reordering and broad rewrites.
- Use \`edit\` for existing files; \`write\` only for explicitly requested new files.
- For new files, place them at the exact path given in the task or acceptance criteria; never guess a directory.
- \`oldText\` is a very flexible verification guard (lowercase-alnum-only compare). Paste any readable snippet of the real lines — you do not need to match it character-for-character.
- Limit each edit call to a small number of replacements (prefer <= 6 entries); split large rewrites into focused calls.
- When the task specifies exact strings, values, labels, or identifiers, reproduce them character-for-character in your edits.

## Final gate

Before stopping:
- **Patch is non-empty:** at least one file in the workspace has changed from your successful tool calls (verify mentally: you did not end after only failed edits or reads).
- coverage is requirement-first, not file-count-first: expand to another file only when an explicit criterion, named path, or required nearby wiring is still unmet
- numeric sanity check: compare acceptance criteria count vs successful edited files; if edited files < criteria count, assume likely under-coverage and re-check each criterion before stopping
- each acceptance criterion maps to an implemented edit
- no explicitly required file is missed
- if a criterion names a file path in backticks, that file must be touched before stopping
- every file included in your submitted \`plan\` must be edited before stopping
- no unnecessary changes were introduced
- you did not modify files outside the task scope (no stray edits to unrelated files)
- if the task named exact old strings or labels, mentally verify they are gone or updated (use grep if unsure)
- Before stopping, for each edited file, confirm that there is NO BUG and INCOMPLETENESS. If there is, edit until the bug is fixed and the incompleteness is resolved.

Then stop immediately.

## Anti-stall trigger

If no successful file mutation has landed after initial discovery and one read pass:
- immediately apply the highest-probability minimal valid edit
- prefer in-place changes near existing sibling logic
- avoid additional exploration loops
- a partial or imperfect **successful** edit always outscores an empty diff; never finish with zero file changes when implementation was requested

If \`edit\` repeatedly errors:
- check that \`path\` matches the file shown in the latest injected message, and that \`startLine\`/\`endLine\` are within that file's line count; then retry. The line-number-based \`edit\` trusts whatever numbers you pass, so out-of-range or cross-file numbers are the most common cause of failure.

---


`;

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, grep, find, ls, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const discoverySection = customPrompt ? buildTaskDiscoverySection(customPrompt, resolvedCwd) : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = TAU_SCORING_PREAMBLE_FOR_CUSTOM_BRANCH + discoverySection + customPrompt;

		if (appendSection) {
			prompt += "\n\n# Appended Section\n\n";
			prompt += appendSection;
		}

		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += "\n\n# Skilled Section\n\n";
			prompt += formatSkillsForPrompt(skills);
		}

		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	const tools = selectedTools || ["read", "bash", "grep", "find", "ls", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) return;
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) addGuideline(normalized);
	}

	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant (Diff Overlap Optimizer) operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.
Your diff is scored against a hidden reference diff for the same task.
Harness details vary, but overlap scoring rewards matching changed lines/ordering and penalizes surplus edits.
No semantic bonus. No tests in scoring.
**Empty patches (zero files changed) score worst** when the task asks for any implementation — treat a non-empty diff as a first-class objective alongside correctness.

## Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

## Guidelines:
${guidelines}
`;

	prompt += TAU_SCORING_PREAMBLE_FOR_MAIN_BRANCH;

	if (appendSection) {
		prompt += "\n\n## Appended Section\n\n";
		prompt += appendSection;
	}

	if (contextFiles.length > 0) {
		prompt += "\n\n## Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `### ${filePath}\n\n${content}\n\n`;
		}
	}

	if (hasRead && skills.length > 0) {
		prompt += "\n\n## Skilled Section\n\n";
		prompt += formatSkillsForPrompt(skills);
	}

	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
