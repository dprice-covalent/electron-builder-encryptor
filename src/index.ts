import fs from 'fs'
import path from 'path'
import asar from 'asar'
import AdmZip from 'adm-zip'
import YAML from 'yaml'
import { log } from 'builder-util'
import { compileToBytenode, encAes, readAppAsarMd5 } from './encrypt'
import { buildConfig, mergeConfig } from './config'
import { mergeDefaultConfig } from './default-config'
import { buildBundle } from './build'
import type { AfterPackContext } from 'electron-builder'

export default function (context: AfterPackContext) {
  return run(context)
}

export interface BeforeRePackAsarContext {
  tempAppDir: string
}

export interface RunOptions {
  beforeRePackAsar?: (context: BeforeRePackAsarContext) => Promise<void>
}

/**
 * 在打包成exe之前做点什么
 */
export async function run(context: AfterPackContext, options: RunOptions = {}) {
  const time = Date.now()

  await buildConfig()
  const encryptorConfig = getConfig()

  const tempAppDir = path.join(context.appOutDir, '../', 'app')

  const resourcesDir = path.join(context.appOutDir, 'resources')
  const appAsarPath = path.join(resourcesDir, 'app.asar')

  // 先解压到缓存目录
  asar.extractAll(appAsarPath, tempAppDir)

  const packageJson = JSON.parse(
    await fs.promises.readFile(path.join(tempAppDir, 'package.json'), 'utf8')
  )
  const mainJsPath = path.join(tempAppDir, packageJson.main)
  const mainDir = path.dirname(mainJsPath)

  const mainJsCPath = path.join(mainDir, 'main-c.jsc')

  // 往main.js添加preload.js
  await fs.promises.writeFile(
    mainJsPath,
    `${await fs.promises.readFile(
      path.join(__dirname, 'preload.js'),
      'utf-8'
    )}\n${await fs.promises.readFile(mainJsPath, 'utf-8')}`,
    'utf-8'
  )

  await mergeConfig(mainJsPath)

  const cwd = process.cwd()
  const shuldCleanFiles = new Set<string>()

  const mainBundlePath = await buildBundle(
    path.relative(cwd, mainJsPath),
    shuldCleanFiles
  )

  // 将main.js加密
  await compileToBytenode(mainBundlePath, mainJsCPath)

  // 修改入口文件
  await fs.promises.writeFile(
    mainJsPath,
    `"use strict";require('bytenode');require('v8').setFlagsFromString('--no-lazy');require('./main-c.jsc');`,
    'utf-8'
  )

  // 将renderer preload.js加密
  const preloadJsPaths =
    typeof encryptorConfig.preload === 'string'
      ? [encryptorConfig.preload]
      : encryptorConfig.preload

  for (const _preloadJsPath of preloadJsPaths) {
    const preloadJsName = path.basename(_preloadJsPath, '.js')
    const rendererPreloadJsPath = path.join(mainDir, _preloadJsPath)
    const preloadJsDir = path.dirname(rendererPreloadJsPath)
    if (fs.existsSync(rendererPreloadJsPath)) {
      const rendererPreloadJsCPath = path.join(
        preloadJsDir,
        `${preloadJsName}-c.jsc`
      )
      const preloadBundlePath = await buildBundle(
        path.relative(cwd, rendererPreloadJsPath),
        shuldCleanFiles
      )

      await compileToBytenode(preloadBundlePath, rendererPreloadJsCPath)
      await fs.promises.writeFile(
        rendererPreloadJsPath,
        `"use strict";require('bytenode');require('v8').setFlagsFromString('--no-lazy');require('./${preloadJsName}-c.jsc');`,
        'utf-8'
      )
    }
  }

  // 清理
  for (const item of shuldCleanFiles) {
    await fs.promises.rm(item, { recursive: true })
  }
  // 删除空目录
  cleanEmptyDir(tempAppDir, [encryptorConfig.renderer.entry, 'node_modules'])

  const rendererDir = path.join(mainDir, encryptorConfig.renderer.entry)
  const entryBaseName = path.basename(encryptorConfig.renderer.entry)
  const rendererTempPath = path.join(mainDir, `${entryBaseName}.pkg`)

  // 加密渲染进程
  await buidMainApp(rendererDir, rendererTempPath, encryptorConfig.key)

  if (encryptorConfig.renderer.output) {
    const rendererOutPath = path.join(
      context.appOutDir,
      encryptorConfig.renderer.output
    )
    const rendererOutDir = path.dirname(rendererOutPath)
    if (!fs.existsSync(rendererOutDir)) {
      await fs.promises.mkdir(rendererOutDir, { recursive: true })
    }
    await fs.promises.rename(rendererTempPath, rendererOutPath)

    const rendererPackageJsonPath = path.join(rendererDir, 'package.json')
    if (fs.existsSync(rendererPackageJsonPath)) {
      await writeLicense(
        rendererOutPath,
        path.resolve(process.cwd(), 'package.json'),
        path.join(rendererOutDir, `${entryBaseName}.yml`),
        encryptorConfig.key
      )
    }
  }

  await fs.promises.rm(rendererDir, { recursive: true })

  if (options.beforeRePackAsar) {
    await options.beforeRePackAsar({ tempAppDir })
  }

  // 搞回去
  await asar.createPackage(tempAppDir, appAsarPath)

  await writeLicense(
    appAsarPath,
    path.resolve(process.cwd(), 'package.json'),
    path.join(resourcesDir, 'app.yml'),
    encryptorConfig.key
  )

  await fs.promises.rm(tempAppDir, { recursive: true })

  log.info(`encrypt success! takes ${Date.now() - time}ms.`)
}

/**
 * 删除目录下的所有空文件夹
 */
function cleanEmptyDir(dir: string, excludes?: string[]) {
  let files = fs.readdirSync(dir)
  if (excludes) {
    files = files.filter(item => !excludes.includes(item))
  }
  if (files.length > 0) {
    files.forEach(file => {
      const fullPath = path.join(dir, file)
      if (fs.statSync(fullPath).isDirectory()) {
        cleanEmptyDir(fullPath)
        if (fs.readdirSync(fullPath).length === 0) {
          fs.rmdirSync(fullPath)
        }
      }
    })
  }
}

async function writeLicense(
  fileDir: string,
  packageJsonPath: string,
  output: string,
  key: string
) {
  const asarMd5 = await readAppAsarMd5(fileDir, key)

  const appPackage = await getAppPackage(packageJsonPath)
  const yamlData = {
    name: appPackage.name,
    version: appPackage.version,
    md5: asarMd5,
  }
  await fs.promises.writeFile(output, YAML.stringify(yamlData), 'utf-8')
}

/**
 * 将mainapp加密打包并藏起来
 * @param { string } input
 */
async function buidMainApp(input: string, output: string, key?: string) {
  const zip = new AdmZip()
  zip.addLocalFolder(input)
  let buf = zip.toBuffer()
  buf = encAes(buf, key)
  await fs.promises.writeFile(output, buf)
}

async function getAppPackage(jsonPath: string) {
  const appPackage = await fs.promises.readFile(jsonPath, 'utf8')
  return JSON.parse(appPackage) as {
    name: string
    version: string
    [key: string]: any
  }
}

export function getConfig() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let encryptorConfig = require(path.resolve(
    process.cwd(),
    'node_modules/.electron-builder-encryptor/encryptor.config.js'
  ))

  encryptorConfig = encryptorConfig.default || encryptorConfig

  return mergeDefaultConfig(encryptorConfig)
}

export { defineConfig } from './config'
