#!/usr/bin/env node

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { parse } from "@typescript-eslint/typescript-estree";

interface DepInfo {
  name: string;
  version: string;
  used: boolean;
  size?: number;
  vulnerable?: boolean;
  suggestions?: string[];
}

const getPackageJson = () => {
  const packageJsonPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(packageJsonPath)) throw new Error("No package.json found");
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
};

const listImports = (source: string): string[] => {
  const ast = parse(source, {
    loc: false,
    range: false,
    comment: false,
    tokens: false,
    ecmaVersion: 2020,
    sourceType: "module",
  });

  const imports: Set<string> = new Set();

  const walkNode = (node: any) => {
    switch (node.type) {
      case "ImportDeclaration":
        if (node.source?.value) {
          imports.add(node.source.value);
        }
        break;

      case "CallExpression":
        if (
          node.callee?.type === "Identifier" &&
          node.callee.name === "require"
        ) {
          const arg = node.arguments?.[0];
          if (arg?.type === "Literal" && typeof arg.value === "string") {
            imports.add(arg.value);
          }
        }
        break;
    }

    for (const key in node) {
      const value = node[key];
      if (Array.isArray(value)) {
        value.forEach(
          (child) =>
            typeof child === "object" && child !== null && walkNode(child)
        );
      } else if (typeof value === "object" && value !== null) {
        walkNode(value);
      }
    }
  };

  walkNode(ast);
  return Array.from(imports);
};

const scanProjectForDeps = (): Set<string> => {
  const imports: Set<string> = new Set();
  const scanDir = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "dist"].includes(entry.name)) {
          scanDir(fullPath);
        }
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
        const code = fs.readFileSync(fullPath, "utf-8");
        listImports(code).forEach((dep) => imports.add(dep.split("/")[0]));
      }
    }
  };
  scanDir(path.join(process.cwd(), "src"));
  return imports;
};

const estimatePackageSize = (pkg: string): number => {
  try {
    const result = execSync(`npm pack ${pkg} --dry-run --json`, {
      encoding: "utf-8",
    });
    const json = JSON.parse(result);
    return json[0].size / 1024;
  } catch {
    return 0;
  }
};

const auditDependencies = (): Record<
  string,
  { vulnerable: boolean; suggestions: string[] }
> => {
  try {
    const auditRaw = execSync("npm audit --json", { encoding: "utf-8" });
    const auditData = JSON.parse(auditRaw);
    const findings: Record<
      string,
      { vulnerable: boolean; suggestions: string[] }
    > = {};

    if (auditData.advisories) {
      for (const key in auditData.advisories) {
        const advisory = auditData.advisories[key];
        const name = advisory.module_name;
        if (!findings[name]) {
          findings[name] = {
            vulnerable: true,
            suggestions: [],
          };
        }
        if (advisory.recommendation) {
          findings[name].suggestions.push(advisory.recommendation);
        }
      }
    }

    return findings;
  } catch (err) {
    console.warn("Audit failed or no vulnerabilities found.");
    return {};
  }
};

const main = async () => {
  const argv = await yargs(hideBin(process.argv))
    .option("clean", {
      type: "boolean",
      description: "Remove unused dependencies",
    })
    .option("analyze", {
      type: "boolean",
      description: "Analyze dependency usage and size",
    })
    .option("suggest", {
      type: "boolean",
      description: "Suggest lighter alternatives",
    })
    .option("audit", {
      type: "boolean",
      description: "Run vulnerability audit using npm audit",
    })
    .parse();

  const pkg = getPackageJson();
  const deps: DepInfo[] = Object.entries(pkg.dependencies || {}).map(
    ([name, version]) => ({
      name,
      version: String(version),
      used: false,
    })
  );

  const usedDeps = scanProjectForDeps();
  const auditMap = argv.audit ? auditDependencies() : {};

  for (const dep of deps) {
    dep.used = usedDeps.has(dep.name);
    if (argv.analyze) {
      dep.size = estimatePackageSize(dep.name);
    }
    if (argv.audit && auditMap[dep.name]) {
      dep.vulnerable = auditMap[dep.name].vulnerable;
      dep.suggestions = auditMap[dep.name].suggestions;
    }
  }

  if (argv.clean) {
    const unused = deps.filter((d) => !d.used);
    if (unused.length === 0) {
      console.log("No unused dependencies found.");
    } else {
      console.log("Removing unused dependencies:");
      unused.forEach((dep) => {
        console.log(` - ${dep.name}`);
        execSync(`npm uninstall ${dep.name}`);
      });
    }
  } else {
    console.table(
      deps.map((d) => ({
        Name: d.name,
        Used: d.used ? "✓" : "✗",
        Size: argv.analyze && d.size ? `${d.size.toFixed(1)} KB` : "-",
        Vulnerable: argv.audit ? (d.vulnerable ? "⚠️" : "✓") : "-",
        Suggestions:
          argv.audit && d.suggestions ? d.suggestions.join(" | ") : "-",
      }))
    );
  }
};

main();
