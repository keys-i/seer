import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const action = resolve(repository, "actions/locale.mjs");
const locales = ["en", "es", "ja", "ko", "zh-Hans"];

function run(workspace, directory, summary, output) {
  return exec(process.execPath, [action], {
    cwd: workspace,
    env: {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: output,
      INPUT_DIRECTORY: directory,
    },
  });
}

async function temporary(context) {
  const root = await mkdtemp(resolve(tmpdir(), "seer-action-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("reports every validated locale and output", async (context) => {
  const root = await temporary(context);
  const summaryPath = resolve(root, "summary.md");
  const outputPath = resolve(root, "output.txt");
  await run(repository, "content", summaryPath, outputPath);

  const summary = await readFile(summaryPath, "utf8");
  assert.ok(summary.startsWith("## Locale\n\n| Language | Locale | Pages |"));
  for (const locale of locales) {
    const language = new Intl.DisplayNames([locale], {
      type: "language",
      languageDisplay: "standard",
    }).of(locale);
    assert.ok(summary.includes(`| ${language} | \`${locale}\` | 1 |`));
  }
  assert.match(summary, /Translation quality is not scored\./);

  const output = Object.fromEntries(
    (await readFile(outputPath, "utf8")).trim().split("\n").map((line) => {
      const equals = line.indexOf("=");
      return [line.slice(0, equals), line.slice(equals + 1)];
    }),
  );
  assert.deepEqual(JSON.parse(output.locales), locales);
  assert.equal(output["locale-count"], "5");
  assert.equal(output["default-locale"], "en");
});

test("reports canonical locales with Unicode extensions", async (context) => {
  const cases = [
    { locale: "en-u-ca-gregory", source: "en", path: "/calendar/" },
    { locale: "zh-Hans-u-nu-hanidec", source: "zh-Hans", path: "/numbers/" },
    { locale: "de-x-private", source: "en", path: "/private/" },
  ];

  for (const item of cases) {
    await context.test(item.locale, async () => {
      const root = await temporary(context);
      await cp(resolve(repository, "content"), resolve(root, "content"), {
        recursive: true,
      });
      const source = resolve(root, `content/${item.source}.json`);
      const content = JSON.parse(await readFile(source, "utf8"));
      content.seo.pages.home.path = item.path;
      await writeFile(resolve(root, `content/${item.locale}.json`), JSON.stringify(content));
      const summaryPath = resolve(root, "summary.md");
      await run(root, "content", summaryPath, resolve(root, "output.txt"));

      const summary = await readFile(summaryPath, "utf8");
      assert.ok(summary.includes(`\`${item.locale}\` | 1 |`));
    });
  }
});

test("rejects unsafe directories with a failure summary", async (context) => {
  const root = await temporary(context);
  const cases = [
    { name: "absolute", directory: resolve(root, "absolute") },
    { name: "drive absolute", directory: "C:\\outside" },
    { name: "traversal", directory: "../outside" },
    { name: "control", directory: "content\n::error::injected" },
    { name: "symlink escape", directory: "content", symlink: true },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const workspace = resolve(root, `workspace-${item.name.replaceAll(" ", "-")}`);
      const outside = resolve(root, `outside-${item.name.replaceAll(" ", "-")}`);
      await mkdir(workspace);
      if (item.symlink) {
        await mkdir(outside);
        await symlink(
          outside,
          resolve(workspace, "content"),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const summary = resolve(root, `summary-${item.name}.md`);
      const output = resolve(root, `output-${item.name}.txt`);
      await assert.rejects(
        run(workspace, item.directory, summary, output),
        /repository-relative|GITHUB_WORKSPACE/,
      );
      assert.match(await readFile(summary, "utf8"), /^## Locale\n\nValidation failed/);
      await assert.rejects(access(output));
    });
  }
});

test("reports invalid locale structure as a failure", async (context) => {
  const root = await temporary(context);
  const workspace = resolve(root, "workspace");
  await mkdir(workspace);
  await cp(resolve(repository, "content"), resolve(workspace, "content"), {
    recursive: true,
  });
  const spanish = resolve(workspace, "content/es.json");
  const content = JSON.parse(await readFile(spanish, "utf8"));
  delete content.home.summary;
  await writeFile(spanish, JSON.stringify(content));
  const summary = resolve(root, "summary.md");
  const output = resolve(root, "output.txt");

  await assert.rejects(
    run(workspace, "content", summary, output),
    /es\.json differs/,
  );
  assert.match(await readFile(summary, "utf8"), /^## Locale\n\nValidation failed/);
  await assert.rejects(access(output));
});

test("neutralizes workflow commands in errors", async (context) => {
  const root = await temporary(context);
  const summary = resolve(root, "summary.md");
  const output = resolve(root, "output.txt");
  const failure = await run(
    root,
    "missing-##[add-mask]secret-::error::pwn",
    summary,
    output,
  ).then(
    () => assert.fail("expected action to fail"),
    (error) => error,
  );

  assert.doesNotMatch(failure.stderr, /##\[|::/u);
  assert.match(failure.stderr, /# #\[add-mask\]secret-: :error: :pwn/u);
  assert.match(await readFile(summary, "utf8"), /^## Locale\n\nValidation failed/);
  await assert.rejects(access(output));
});
