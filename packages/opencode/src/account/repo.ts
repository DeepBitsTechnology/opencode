import { eq } from "drizzle-orm"
import { Effect, Layer, Option, Schema, ServiceMap } from "effect"

import { Database } from "@/storage/db"
import { AccountStateTable, AccountTable } from "./account.sql"
import { AccessToken, Account, AccountID, AccountRepoError, OrgID, RefreshToken } from "./schema"

export type AccountRow = (typeof AccountTable)["$inferSelect"]

type DbClient = Parameters<typeof Database.use>[0] extends (db: infer T) => unknown ? T : never

const ACCOUNT_STATE_ID = 1

export namespace AccountRepo {
  export interface Service {
    readonly active: () => Effect.Effect<Option.Option<Account>, AccountRepoError>
    readonly list: () => Effect.Effect<Account[], AccountRepoError>
    readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountRepoError>
    readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountRepoError>
    readonly getRow: (accountID: AccountID) => Effect.Effect<Option.Option<AccountRow>, AccountRepoError>
    readonly persistToken: (input: {
      accountID: AccountID
      accessToken: AccessToken
      refreshToken: RefreshToken
      expiry: Option.Option<number>
    }) => Effect.Effect<void, AccountRepoError>
    readonly persistAccount: (input: {
      id: AccountID
      email: string
      url: string
      accessToken: AccessToken
      refreshToken: RefreshToken
      expiry: number
      orgID: Option.Option<OrgID>
    }) => Effect.Effect<void, AccountRepoError>
  }
}

export class AccountRepo extends ServiceMap.Service<AccountRepo, AccountRepo.Service>()("@opencode/AccountRepo") {
  static readonly layer: Layer.Layer<AccountRepo> = Layer.effect(
    AccountRepo,
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownSync(Account)

      const query = <A>(f: (db: DbClient) => Promise<A>) =>
        Effect.tryPromise({
          try: () => Database.use(f),
          catch: (cause) => new AccountRepoError({ message: "Database operation failed", cause }),
        })

      const tx = <A>(f: (db: DbClient) => Promise<A>) =>
        Effect.tryPromise({
          try: () => Database.transaction(f),
          catch: (cause) => new AccountRepoError({ message: "Database operation failed", cause }),
        })

      const current = async (db: DbClient) => {
        const state = await db.select().from(AccountStateTable).where(eq(AccountStateTable.id, ACCOUNT_STATE_ID)).get()
        if (!state?.active_account_id) return
        const account = await db.select().from(AccountTable).where(eq(AccountTable.id, state.active_account_id)).get()
        if (!account) return
        return { ...account, active_org_id: state.active_org_id ?? null }
      }

      const state = async (db: DbClient, accountID: AccountID, orgID: Option.Option<OrgID>) => {
        const id = Option.getOrNull(orgID)
        return db
          .insert(AccountStateTable)
          .values({ id: ACCOUNT_STATE_ID, active_account_id: accountID, active_org_id: id })
          .onConflictDoUpdate({
            target: AccountStateTable.id,
            set: { active_account_id: accountID, active_org_id: id },
          })
          .run()
      }

      const active = Effect.fn("AccountRepo.active")(() =>
        query(async (db) => current(db)).pipe(Effect.map((row) => (row ? Option.some(decode(row)) : Option.none()))),
      )

      const list = Effect.fn("AccountRepo.list")(() =>
        query(async (db) => {
          const rows = await db.select().from(AccountTable).all()
          return rows.map((row: AccountRow) => decode({ ...row, active_org_id: null }))
        }),
      )

      const remove = Effect.fn("AccountRepo.remove")((accountID: AccountID) =>
        tx(async (db) => {
          await db
            .update(AccountStateTable)
            .set({ active_account_id: null, active_org_id: null })
            .where(eq(AccountStateTable.active_account_id, accountID))
            .run()
          await db.delete(AccountTable).where(eq(AccountTable.id, accountID)).run()
        }).pipe(Effect.asVoid),
      )

      const use = Effect.fn("AccountRepo.use")((accountID: AccountID, orgID: Option.Option<OrgID>) =>
        query(async (db) => state(db, accountID, orgID)).pipe(Effect.asVoid),
      )

      const getRow = Effect.fn("AccountRepo.getRow")((accountID: AccountID) =>
        query(async (db) => db.select().from(AccountTable).where(eq(AccountTable.id, accountID)).get()).pipe(
          Effect.map(Option.fromNullishOr),
        ),
      )

      const persistToken = Effect.fn("AccountRepo.persistToken")((input) =>
        query(async (db) =>
          db
            .update(AccountTable)
            .set({
              access_token: input.accessToken,
              refresh_token: input.refreshToken,
              token_expiry: Option.getOrNull(input.expiry),
            })
            .where(eq(AccountTable.id, input.accountID))
            .run(),
        ).pipe(Effect.asVoid),
      )

      const persistAccount = Effect.fn("AccountRepo.persistAccount")((input) =>
        tx(async (db) => {
          await db
            .insert(AccountTable)
            .values({
              id: input.id,
              email: input.email,
              url: input.url,
              access_token: input.accessToken,
              refresh_token: input.refreshToken,
              token_expiry: input.expiry,
            })
            .onConflictDoUpdate({
              target: AccountTable.id,
              set: {
                access_token: input.accessToken,
                refresh_token: input.refreshToken,
                token_expiry: input.expiry,
              },
            })
            .run()
          await state(db, input.id, input.orgID)
        }).pipe(Effect.asVoid),
      )

      return AccountRepo.of({
        active,
        list,
        remove,
        use,
        getRow,
        persistToken,
        persistAccount,
      })
    }),
  )
}
