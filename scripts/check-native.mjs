import Database from 'better-sqlite3'
import { createCanvas } from '@napi-rs/canvas'
const db = new Database(':memory:')
try { db.prepare('SELECT 1').get(); createCanvas(1, 1); console.log('Native N-API modules ready (Node and Electron share the same bindings)') } finally { db.close() }
