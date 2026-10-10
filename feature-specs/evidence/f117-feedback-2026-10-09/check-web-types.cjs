// Compare the candidate and its exact base through a compiler host; do not
// modify the checkout or hide any diagnostic from the full web project.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const root = process.cwd();
const web = path.join(root, 'packages/web');
const ts = createRequire(path.join(web, 'package.json'))('typescript');
const base = 'd015c806d91839658788a32593735e3f4ff99254';
const changed = execFileSync('git', ['diff', '--name-only', base], { cwd: root, encoding: 'utf8' }).trim().split('\n');
const baseline = new Map(
  changed
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .map((file) => [
      path.join(root, file),
      execFileSync('git', ['show', `${base}:${file}`], { cwd: root, encoding: 'utf8' }),
    ]),
);
const configFile = ts.readConfigFile(path.join(web, 'tsconfig.json'), ts.sys.readFile);
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, web);
function check(useBase) {
  const host = ts.createCompilerHost(config.options);
  const read = host.readFile.bind(host);
  host.readFile = (file) => (useBase && baseline.has(file) ? baseline.get(file) : read(file));
  const program = ts.createProgram(config.fileNames, { ...config.options, incremental: false }, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const position =
      diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : undefined;
    return {
      file: diagnostic.file ? path.relative(root, diagnostic.file.fileName) : null,
      line: position ? position.line + 1 : null,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    };
  });
}
const candidate = check(false);
const baseDiagnostics = check(true);
const result = {
  base,
  replacedBaseFiles: baseline.size,
  candidate,
  baseDiagnostics,
  sameDiagnostics: JSON.stringify(candidate) === JSON.stringify(baseDiagnostics),
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.sameDiagnostics ? 0 : 1;
