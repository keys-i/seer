import { appendFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readProject } from "../src/index.js";

const clean = (value: unknown) => String(value)
  .replace(/[\p{Cc}\p{Cf}]/gu, " ")
  .replaceAll("##[", "# #[")
  .replaceAll("::", ": :")
  .slice(0, 2_000);

function outside(root: string, target: string) {
  const path = relative(root, target);
  return isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`);
}

function cell(value: unknown) {
  return clean(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\s+/gu, " ")
    .trim();
}

async function append(path: string | undefined, value: string) {
  if (path) await appendFile(path, value, "utf8");
}

async function main() {
  const directory = (process.env.INPUT_DIRECTORY ?? "content").trim();
  if (
    !directory ||
    isAbsolute(directory) ||
    /^[A-Za-z]:/.test(directory) ||
    /^[/\\]{2}/.test(directory) ||
    directory.split(/[/\\]+/u).includes("..") ||
    /[\p{Cc}\p{Cf}]/u.test(directory)
  ) {
    throw new Error("directory must be a repository-relative path without traversal");
  }

  const workspace = await realpath(
    process.env.GITHUB_WORKSPACE ?? process.cwd(),
  );
  const target = await realpath(resolve(workspace, directory));
  if (outside(workspace, target)) {
    throw new Error("directory must stay inside GITHUB_WORKSPACE");
  }

  const project = await readProject({ dir: target });
  const rows = project.locales.map((locale) => {
    const baseName = new Intl.Locale(locale).baseName;
    const language = new Intl.DisplayNames([locale], {
      type: "language",
      languageDisplay: "standard",
    }).of(baseName) ?? baseName;
    const pages = Object.keys(project.pages[locale] ?? {}).length;
    return `| ${cell(language)} | \`${locale}\` | ${pages} |`;
  });
  const summary = [
    "## Locale",
    "",
    "| Language | Locale | Pages |",
    "| --- | --- | ---: |",
    ...rows,
    "",
    "Structure checks key, type, array-shape, page-ID, and indexability parity. Translation quality is not scored.",
    "",
  ].join("\n");

  await append(process.env.GITHUB_STEP_SUMMARY, summary);
  await append(process.env.GITHUB_OUTPUT, [
    `locales=${JSON.stringify(project.locales)}`,
    `locale-count=${project.locales.length}`,
    `default-locale=${project.config.defaultLocale}`,
    "",
  ].join("\n"));
}

await main().catch(async (error: unknown) => {
  try {
    await append(
      process.env.GITHUB_STEP_SUMMARY,
      "## Locale\n\nValidation failed; see log.\n",
    );
  } catch (summaryError: unknown) {
    console.error(`seer locale summary: ${clean(
      summaryError instanceof Error ? summaryError.message : summaryError,
    )}`);
  }
  console.error(`seer locale: ${clean(
    error instanceof Error ? error.message : error,
  )}`);
  process.exitCode = 1;
});
