#!/usr/bin/env node
import { fetchAll } from '../lib/fetcher'

const printUsage = () => {
  console.log(`
用法: npm run fetch <command>

命令:
  all       全量抓取所有信息源数据

示例:
  npm run fetch all
`)
}

const parseArgs = () => {
  const args = process.argv.slice(2)
  const command = args[0]
  
  const options: Record<string, string> = {}
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].substring(2)
      const value = args[i + 1]
      if (value && !value.startsWith('--')) {
        options[key] = value
        i++
      }
    }
  }
  
  return { command, options }
}

const main = async () => {
  const { command, options } = parseArgs()
  
  switch (command) {
    case 'all':
      await fetchAll()
      break
    case 'help':
    case '--help':
    case '-h':
      printUsage()
      break
    default:
      if (command) {
        console.error(`未知命令: ${command}`)
      }
      printUsage()
      process.exit(command ? 1 : 0)
  }
}

main().catch(console.error)
