/**
 * Zustand persist 的异步存储适配器：优先使用 IndexedDB 保存可能较大的知识库状态，
 * 浏览器不支持 IndexedDB 时回退到 localStorage，并在 IndexedDB 首次读取时迁移旧值。
 * IndexedDB 的打开、请求与事务均转换成 Promise，方便满足 StateStorage 接口。
 */
import type { StateStorage } from 'zustand/middleware'

const DB_NAME = 'ai-react-demo'
const STORE_NAME = 'persisted-state'
let database: Promise<IDBDatabase> | undefined

// 复用同一个打开中的 Promise，避免多个 store 初始化时重复创建连接。
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

/** 等待事务提交完成，而非只等单条 request 成功，确保写入已真正落库。 */
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('本地数据库操作失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('本地数据库操作已取消'))
  })
}

/** 将单条 IndexedDB 请求的成功/失败回调转换为 Promise。 */
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('本地数据库读取失败'))
  })
}

export const indexedDbStorage: StateStorage = {
  async getItem(name) {
    // 不支持 IndexedDB 时回退到 localStorage；旧数据在首次读取时迁移到新库。
    if (typeof indexedDB === 'undefined') return localStorage.getItem(name)
    const db = await openDatabase()
    const tx = db.transaction(STORE_NAME, 'readonly')
    // 先查新库；只有新库没有该 key 时才检查旧 localStorage，避免旧值覆盖新值。
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
