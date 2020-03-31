#!/usr/bin/env node
'use strict';
/* eslint-disable no-unused-vars */
const path = require('path'),
    fs = require('fs'),
    Packman = require('./code-packman');
let { exec, spawn } = require('child_process');
// the argument index for the packaging script
const ARGV_PROCESS_PACKAGING_SCRIPT_NAME = 2;
const REAL_PROJECT_ROOT = path.resolve(__dirname, '../');
const REAL_PROJECT_DIRNAME = path.parse(path.resolve(__dirname, '../')).base;

async function makeDistAWSLambdaFadcAsgHandler(options = { saveToDist: 'zip', keepTemp: false }) {
    console.info('Making distribution zip package for: AWS FortiADC Autoscale Handler function');
    let pm = Packman.spawn(),
        packageName = options.packageName ? options.packageName : 'lambda',
        rTempDir = await pm.makeTempDir(),
        rTempDirSrc = path.resolve(rTempDir, 'package'),
        rTempDirSrcLambda = path.resolve(rTempDirSrc, packageName),
        rTempDirSrcNM = path.resolve(rTempDirSrcLambda, 'node_modules'),
        packageInfo,
        zipFilePath,
        rDirDist = path.resolve(REAL_PROJECT_ROOT, './dist'),
        rDirPkg = path.resolve(REAL_PROJECT_ROOT, '../packages'),
        rDirSrcLambda = path.resolve(REAL_PROJECT_ROOT, './'),
        zipFileName,
        packageType,
        saveAs;

    // create temp dirs
    await pm.makeDir(rTempDirSrc);
    await pm.makeDir(rDirDist);
    // copy lambda module to temp dir
    await pm.copyAndDelete(rDirSrcLambda, rTempDirSrcLambda, [
        'node_modules',
        'local*',
        'test',
        '.nyc_output',
        '.vscode',
        'package-lock.json',
        'scripts',
        'dist'
    ]);
  
   
    // install aws as dependency
    await pm.npmInstallAt(rTempDirSrcLambda, [
        '--save'
       
    ]);
    
    await pm.deleteAllExcept('node_modules', rTempDirSrcLambda);
    // read package info of module lambda
    
    packageInfo = pm.readPackageJsonAt(rTempDirSrcLambda);
    // if a package name is given in the options, use the package name as zip name,
    // otherwise use the package name in the package.json
    zipFileName = options.packageName ? `${packageName}.zip` : `${packageInfo.name}.zip`;
    // if only make zip file distribution file
    if (options.saveToDist === 'zip') {
        // zip
        zipFilePath = await pm.zipSafe(zipFileName, rTempDirSrcLambda, ['*.git*', '*.vsc*']);
        // copy the zip file to distribution directory
        await pm.copy(zipFilePath, rDirDist);
        // move zip file to upper level directory
        await pm.moveSafe(zipFilePath, path.resolve(rTempDirSrcLambda, '..'));
        packageType = 'zip';
        saveAs = path.resolve(rDirDist, zipFileName);
        await pm.copy(saveAs, rDirPkg + '/lambda.zip');
    } else if (options && options.saveToDist === 'directory') {
        // copy folder to distribution directory
        await pm.copy(rTempDirSrcLambda, rDirDist);
        packageType = 'directory';
        saveAs = rDirSrcLambda;
    } else {
        // save the zip file to the temp directory
        zipFilePath = await pm.zipSafe(zipFileName, rTempDirSrcLambda, ['*.git*', '*.vsc*']);
        // move zip file to upper level directory
        await pm.moveSafe(zipFilePath, path.resolve(rTempDirSrcLambda, '..'));
        zipFilePath = path.resolve(rTempDirSrcLambda, '..', zipFileName);
        packageType = 'zip';
        saveAs = zipFilePath;
    }
    // if keep temp is true, the kept temp dir will be return and the calle is responsible for
    // deleteing it after use.
    
    if (!(options && options.keepTemp)) {
        await pm.removeTempDir();
    }
    
    console.info('\n\n( ͡° ͜ʖ ͡°) package is saved as:');
    console.info(`${saveAs}`);
    return {
        tempDir: rTempDir,
        packageInfo: packageInfo,
        packageFileName: zipFileName,
        packageName: packageName,
        packagePath: saveAs,
        packageType: packageType,
        sourceDir: rTempDirSrcLambda,
        removeTempDir: async () => {
            await pm.removeTempDir();
        } // this holds a reference to the function to remove temp
    };
}

let scrptName = process.argv[ARGV_PROCESS_PACKAGING_SCRIPT_NAME] || 'default';
// make distribution package
switch (scrptName.toLowerCase()) {
   
    case 'aws-lambda':
        makeDistAWSLambdaFadcAsgHandler();
        break;
    
    default:
        console.warn('( ͡° ͜ʖ ͡°) Usage: please use one of these commands:');
        console.warn('npm run build-aws-lambda');
        break;
}
/* eslint-enable no-unused-vars */
