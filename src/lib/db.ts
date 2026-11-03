/**
 * Firestore 操作統一出口。
 * 真實模式：直接轉呼叫 firebase/firestore；
 * 展示模式（demo 登入）：走 demoStore 記憶體實作，不碰真實資料庫。
 *
 * 各頁只需把 `from "firebase/firestore"` 改為 `from "../lib/db"`（lib 內為 "./db"），
 * 其餘呼叫寫法不變（第一個 db 參數在展示模式下會被忽略）。
 *
 * 型別刻意放寬為 any：同一份呼叫碼要同時相容真實 SDK 與記憶體實作。
 */
import { isDemoMode } from "./demoMode";
import * as demo from "./demoStore";
import {
  collection as fsCollection,
  deleteDoc as fsDeleteDoc,
  doc as fsDoc,
  getDoc as fsGetDoc,
  getDocs as fsGetDocs,
  limit as fsLimit,
  orderBy as fsOrderBy,
  query as fsQuery,
  serverTimestamp as fsServerTimestamp,
  setDoc as fsSetDoc,
  updateDoc as fsUpdateDoc,
  where as fsWhere,
  writeBatch as fsWriteBatch,
  type DocumentSnapshot,
  type QuerySnapshot,
} from "firebase/firestore";

export type { Firestore, WriteBatch } from "firebase/firestore";

const demoOn = (): boolean => isDemoMode();

/* eslint-disable @typescript-eslint/no-explicit-any */

export function collection(db: any, ...path: string[]): any {
  return demoOn()
    ? demo.collection(path.join("/"))
    : (fsCollection as (...a: any[]) => any)(db, ...path);
}

export function doc(first: any, ...segments: string[]): any {
  return demoOn() ? demo.docOf(first, ...segments) : fsDoc(first, ...segments);
}

export function getDoc(ref: any): Promise<DocumentSnapshot> {
  return demoOn()
    ? Promise.resolve(demo.getDoc(ref) as unknown as DocumentSnapshot)
    : fsGetDoc(ref);
}

export function getDocs(ref: any): Promise<QuerySnapshot> {
  return demoOn()
    ? Promise.resolve(demo.getDocs(ref) as unknown as QuerySnapshot)
    : fsGetDocs(ref);
}

export function setDoc(ref: any, data: any, options?: any): Promise<void> {
  return demoOn()
    ? Promise.resolve(demo.setDoc(ref, data, options))
    : fsSetDoc(ref, data, options);
}

export function updateDoc(ref: any, data: any): Promise<void> {
  return demoOn()
    ? Promise.resolve(demo.updateDoc(ref, data))
    : fsUpdateDoc(ref, data);
}

export function deleteDoc(ref: any): Promise<void> {
  return demoOn()
    ? Promise.resolve(demo.deleteDoc(ref))
    : fsDeleteDoc(ref);
}

export function query(ref: any, ...constraints: any[]): any {
  return demoOn() ? demo.query(ref, ...constraints) : fsQuery(ref, ...constraints);
}

export function where(field: string, op: string, value: any): any {
  return demoOn()
    ? demo.where(field, op, value)
    : (fsWhere as (...a: any[]) => any)(field, op, value);
}

export function orderBy(field: string, dir?: "asc" | "desc"): any {
  return demoOn() ? demo.orderBy(field, dir ?? "asc") : fsOrderBy(field, dir as any);
}

export function limit(n: number): any {
  return demoOn() ? demo.limit(n) : fsLimit(n);
}

export function serverTimestamp(): any {
  return demoOn() ? demo.serverTimestamp() : fsServerTimestamp();
}

export function writeBatch(db: any): any {
  return demoOn() ? demo.writeBatch() : fsWriteBatch(db);
}
