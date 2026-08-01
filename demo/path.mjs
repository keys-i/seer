import { resolve } from "node:path";
import { safeDirectory } from "../dist/src/project.js";

export function pageDirectory(output, pagePath, resolvePath = resolve) {
  if (pagePath === "/") return resolvePath(output);
  if (!pagePath.endsWith("/")) {
    throw new Error(`demo page path must end in /: ${pagePath}`);
  }
  const directory = pagePath.slice(1, -1);
  if (
    directory.includes("%") ||
    safeDirectory(directory, "demo page path") !== directory ||
    directory.normalize("NFC") !== directory
  ) {
    throw new Error(`demo page path must be canonical: ${pagePath}`);
  }
  return resolvePath(output, directory);
}

export function assertDistinctFiles(files) {
  const paths = new Set(files.map((file) =>
    file.normalize("NFC").toUpperCase().normalize("NFC"),
  ));
  if (paths.size !== files.length) throw new Error("demo output collision");
  for (const file of paths) {
    let parent = file;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (paths.has(parent)) throw new Error("demo output collision");
    }
  }
}
