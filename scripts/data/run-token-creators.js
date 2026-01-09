/* eslint-disable @typescript-eslint/no-var-requires */
const path = require('node:path');

const { register } = require('ts-node');

register({
  project: path.resolve(__dirname, '../../tsconfig.scripts.json'),
  transpileOnly: true,
});

require(path.resolve(__dirname, 'listTokenCreators.ts'));
