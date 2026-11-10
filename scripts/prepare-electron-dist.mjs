import { cp, rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const source = resolve('node_modules/electron/dist')
const destination = resolve('.tmp/electron-dist')
const defaultApp = `${resolve('node_modules/electron/dist/resources/default_app.asar')}`
await rm(destination, { recursive: true, force: true })
await cp(source, destination, {
  recursive: true,
  filter: (path) => resolve(path) !== defaultApp && !resolve(path).startsWith(`${defaultApp}${sep}`),
})
