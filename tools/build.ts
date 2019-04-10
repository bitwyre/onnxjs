// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import {execSync, spawnSync} from 'child_process';
import * as fs from 'fs';
import * as globby from 'globby';
import logger from 'npmlog';
import * as path from 'path';
import * as rimraf from 'rimraf';

logger.info('Build', 'Initializing...');

// Flags
// To trigger fetching some WASM dependencies and some post-processing
const buildWasm = process.argv.indexOf('--build-wasm') !== -1;
// To trigger a clean install
const cleanInstall = process.argv.indexOf('--clean-install') !== -1;
// To call webpack to generate the bundle .js file
const buildBundle = process.argv.indexOf('--build-bundle') !== -1;

// tslint:disable: non-literal-fs-path

// Path variables
const ROOT = path.join(__dirname, '..');
const DEPS = path.join(ROOT, 'deps');
const DEPS_EIGEN = path.join(DEPS, 'eigen');
const DEPS_EMSDK = path.join(DEPS, 'emsdk');
const DEPS_EMSDK_EMSCRIPTEN = path.join(DEPS_EMSDK, 'emscripten');
const EMSDK_BIN = path.join(DEPS_EMSDK, 'emsdk');
const SRC = path.join(ROOT, 'src');
const SRC_WASM_BUILD_CONFIG = path.join(SRC, 'wasm-build-config.json');
const OUT = path.join(ROOT, 'dist');
const OUT_WASM_JS = path.join(OUT, 'onnx-wasm.js');
const OUT_WASM = path.join(OUT, 'onnx-wasm.wasm');

// Emcc (for Wasm) compile flags
// Add new compiler flags here (if needed)
const BUILD_OPTIONS = [
  '-I' + DEPS_EIGEN,
  '-DEIGEN_MPL2_ONLY',
  '-std=c++11',
  '-s WASM=1',
  '-s NO_EXIT_RUNTIME=0',
  '-s ALLOW_MEMORY_GROWTH=1',
  '-s SAFE_HEAP=0',
  '-s MODULARIZE=1',
  '-s SAFE_HEAP_LOG=0',
  '-s STACK_OVERFLOW_CHECK=0',
  '-s DEBUG_LEVEL=0',
  '-s VERBOSE=0',
  '-s EXPORT_ALL=0',
  '-o ' + OUT_WASM_JS,
  '-O2',
  '--llvm-lto 3',
];

logger.info('Build', 'Initialization completed. Start to build...');

if (!fs.existsSync(OUT)) {
  logger.info('Build', `Creating output folder: ${OUT}`);
  fs.mkdirSync(OUT);
}

logger.info('Build', 'Updating submodules...');
// Step 1: Clean folders if needed
logger.info('Build.SubModules', '(1/2) Cleaning dependencies folder...');
if (cleanInstall) {
  rimraf.sync(DEPS);
}
logger.info('Build.SubModules', `(1/2) Cleaning dependencies folder... ${cleanInstall ? 'DONE' : 'SKIPPED'}`);

// Step 2: Get dependencies (if needed)
logger.info('Build.SubModules', '(2/2) Fetching submodules...');
const update = spawnSync('git submodule update --init --recursive', {shell: true, stdio: 'inherit', cwd: ROOT});
if (update.status !== 0) {
  if (update.error) {
    console.error(update.error);
  }
  process.exit(update.status);
}
logger.info('Build.SubModules', '(2/2) Fetching submodules... DONE');

logger.info('Build', 'Updating submodules... DONE');

logger.info('Build', 'Building WebAssembly sources...');
if (!buildWasm) {
  // if not building Wasm AND the file onnx-wasm.js is not present, create a place holder file
  if (!fs.existsSync(OUT_WASM_JS)) {
    logger.info('Build.Wasm', `Writing fallback target file: ${OUT_WASM_JS}`);
    fs.writeFileSync(OUT_WASM_JS, `;throw new Error("please build WebAssembly before use wasm backend.");`);
  }
} else {
  // Step 1: emsdk install (if needed)
  logger.info('Build.Wasm', '(1/4) Setting up emsdk...');
  if (!fs.existsSync(DEPS_EMSDK_EMSCRIPTEN)) {
    logger.info('Build.Wasm', 'Installing emsdk...');
    const install = spawnSync(`${EMSDK_BIN} install latest`, {shell: true, stdio: 'inherit', cwd: DEPS_EMSDK});
    if (install.status !== 0) {
      if (install.error) {
        console.error(install.error);
      }
      process.exit(install.status);
    }
    logger.info('Build.Wasm', 'Installing emsdk... DONE');

    logger.info('Build.Wasm', 'Activating emsdk...');
    const activate = spawnSync(`${EMSDK_BIN} activate latest`, {shell: true, stdio: 'inherit', cwd: DEPS_EMSDK});
    if (activate.status !== 0) {
      if (activate.error) {
        console.error(activate.error);
      }
      process.exit(activate.status);
    }
    logger.info('Build.Wasm', 'Activating emsdk... DONE');
  }
  logger.info('Build.Wasm', '(1/4) Setting up emsdk... DONE');

  // Step 2: Find path to emcc
  logger.info('Build.Wasm', '(2/4) Find path to emcc...');
  let emcc = globby.sync('./emscripten/**/emcc', {cwd: DEPS_EMSDK})[0];
  if (!emcc) {
    logger.error('Build.Wasm', 'Unable to find emcc. Try re-building with --clean-install flag.');
    process.exit(2);
  }
  emcc = path.join(DEPS_EMSDK, emcc);
  logger.info('Build.Wasm', `(2/4) Find path to emcc... DONE, emcc: ${emcc}`);

  // Step 3: Prepare build config
  logger.info('Build.Wasm', '(3/4) Preparing build config...');
  // tslint:disable-next-line:non-literal-require
  const wasmBuildConfig = require(SRC_WASM_BUILD_CONFIG);
  const exportedFunctions = wasmBuildConfig.exported_functions as string[];
  const srcPatterns = wasmBuildConfig.src as string[];
  if (exportedFunctions.length === 0) {
    logger.error('Build.Wasm', `No exported functions specified in the file: ${SRC_WASM_BUILD_CONFIG}`);
    process.exit(1);
  }

  BUILD_OPTIONS.push(`-s "EXPORTED_FUNCTIONS=[${exportedFunctions.map(f => `${f}`).join(',')}]"`);

  const cppFileNames = globby.sync(srcPatterns, {cwd: SRC});
  if (cppFileNames.length === 0) {
    logger.error('Build.Wasm', 'Unable to find any cpp source files to compile and generate the WASM file');
    process.exit(2);
  }

  const compileSourcesString = cppFileNames.map(f => path.join(SRC, f)).join(' ');
  BUILD_OPTIONS.push(compileSourcesString);
  logger.info('Build.Wasm', '(3/4) Preparing build config... DONE');

  // Step 4: Compile the source code to generate the Wasm file
  logger.info('Build.Wasm', '(4/4) Building...');
  logger.info('Build.Wasm', `CMD: ${emcc} ${BUILD_OPTIONS}`);

  const emccBuild = spawnSync(emcc, BUILD_OPTIONS, {shell: true, stdio: 'inherit', cwd: __dirname});

  if (emccBuild.error) {
    console.error(emccBuild.error);
    process.exit(emccBuild.status);
  }
  logger.info('Build.Wasm', '(4/4) Building... DONE');
}
logger.info('Build', `Building WebAssembly sources... ${buildWasm ? 'DONE' : 'SKIPPED'}`);

// generate bundle
//
logger.info('Build', `Building bundle...`);
if (buildBundle) {
  // only generate bundle when WASM is built
  //
  if (!fs.existsSync(OUT_WASM)) {
    logger.error('Build.Bundle', `Cannot find wasm file: ${OUT_WASM}. Please build WebAssembly sources first.`);
    process.exit(2);
  } else {
    logger.info('Build.Bundle', '(1/2) Retrieving npm bin folder...');
    const npmBin = execSync('npm bin', {encoding: 'utf8'}).trimRight();
    logger.info('Build.Bundle', `(1/2) Retrieving npm bin folder... DONE, folder: ${npmBin}`);

    logger.info('Build.Bundle', '(2/2) Running webpack to generate onnx.min.js...');
    const webpackCommand = path.join(npmBin, 'webpack');
    const webpackArgs = ['--mode', 'production'];
    logger.info('Build.Bundle', `CMD: ${webpackCommand} ${webpackArgs.join(' ')}`);
    const webpack = spawnSync(webpackCommand, webpackArgs, {shell: true, stdio: 'inherit'});
    if (webpack.status !== 0) {
      console.error(webpack.error);
      process.exit(webpack.status);
    }
    logger.info('Build.Bundle', '(2/2) Running webpack to generate onnx.min.js... DONE');
  }
}
logger.info('Build', `Building bundle... ${buildBundle ? 'DONE' : 'SKIPPED'}`);
