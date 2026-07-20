/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-is-platform-neutral',
      severity: 'error',
      from: { path: '^src/core/' },
      to: { path: '^src/(main|preload|renderer)/' },
    },
    {
      name: 'renderer-cannot-reach-privileged-code',
      severity: 'error',
      from: { path: '^src/renderer/' },
      to: { path: '^src/(main|preload)/' },
    },
    {
      name: 'shared-cannot-reach-runtime-code',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(main|preload|renderer)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '(^|/)(dist|dist-electron|release|target|node_modules|test-artifacts)(/|$)',
    },
    moduleSystems: ['cjs', 'es6'],
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      conditionNames: ['import', 'require', 'node', 'default'],
      exportsFields: ['exports'],
    },
  },
}
