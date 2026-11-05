import type { StateStorage } from 'zustand/middleware'

const DB_NAME = 'ai-react-demo'
const STORE_NAME = 'persisted-state'
let database: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    const opening: Promise<IDBDatabase> = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'))
      request.onblocked = () => reject(new Error('本地数据库升级被其他页面阻止'))
    })
    database = opening.catch((error: unknown) => {
      database = undefined
      throw error
    })
  }
  return database!
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('本地数据库操作失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('本地数据库操作已取消'))
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('本地数据库读取失败'))
  })
}

export const indexedDbStorage: StateStorage = {
  async getItem(name) {
    if (typeof indexedDB === 'undefined') return localStorage.getItem(name)
    const db = await openDatabase()
    const tx = db.transaction(STORE_NAME, 'readonly')
    const value = await requestResult(tx.objectStore(STORE_NAME).get(name))
    if (typeof value === 'string') return value

    const legacy = localStorage.getItem(name)
    if (legacy !== null) {
      await this.setItem(name, legacy)
      localStorage.removeItem(name)
    }
    return legacy
  },
  async setItem(name, value) {
    if (typeof indexedDB === 'undefined') {
      localStorage.setItem(name, value)
      return
    }
    const db = await openDatabase()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(value, name)
    await transactionDone(tx)
  },
  async removeItem(name) {
    if (typeof indexedDB === 'undefined') {
      localStorage.removeItem(name)
      return
    }
    const db = await openDatabase()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(name)
    await transactionDone(tx)
  },
}
