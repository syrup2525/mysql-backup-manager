import formbody from "@fastify/formbody";
import ejs from "ejs";
import fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAuthStore, type AuthStore } from "../shared/auth.js";
import { appConfig } from "../shared/config.js";
import { listBackupFiles } from "../shared/files.js";
import { isSafePathSegment } from "../shared/paths.js";
import { createBackupTargetStore, type BackupTargetStore } from "../shared/store.js";
import type { BackupTarget, BackupTargetInput } from "../shared/types.js";

type FormBody = Record<string, string | string[] | undefined>;

const viewsDir = path.join(process.cwd(), "src/web/views");
const stylesPath = path.join(process.cwd(), "src/web/public/styles.css");
const publicPaths = new Set(["/healthz", "/login", "/styles.css"]);

declare module "fastify" {
  interface FastifyRequest {
    authUser?: string;
    sessionToken?: string;
  }
}

function firstValue(body: FormBody, key: string): string {
  const value = body[key];
  if (Array.isArray(value)) {
    return value[0] || "";
  }

  return value || "";
}

function parseTargetInput(body: FormBody): { input?: BackupTargetInput; errors: string[] } {
  const errors: string[] = [];
  const database = firstValue(body, "database").trim();
  const host = firstValue(body, "host").trim() || "127.0.0.1";
  const username = firstValue(body, "username").trim();
  const password = firstValue(body, "password");
  const name = firstValue(body, "name").trim();
  const portText = firstValue(body, "port").trim() || "3306";
  const port = Number.parseInt(portText, 10);

  if (!database) {
    errors.push("데이터베이스 이름을 입력하세요.");
  } else if (!isSafePathSegment(database)) {
    errors.push("데이터베이스 이름에는 / 또는 \\ 문자를 사용할 수 없습니다.");
  }

  if (!host) {
    errors.push("호스트를 입력하세요.");
  }

  if (!username) {
    errors.push("계정을 입력하세요.");
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push("포트는 1부터 65535 사이의 숫자여야 합니다.");
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    errors,
    input: {
      name,
      host,
      port,
      database,
      username,
      password,
      enabled: firstValue(body, "enabled") === "on"
    }
  };
}

function targetToInput(target: BackupTarget): BackupTargetInput {
  return {
    name: target.name,
    host: target.host,
    port: target.port,
    database: target.database,
    username: target.username,
    password: target.password,
    enabled: target.enabled
  };
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator === -1) {
          return [part, ""];
        }

        const rawValue = part.slice(separator + 1);
        try {
          return [part.slice(0, separator), decodeURIComponent(rawValue)];
        } catch {
          return [part.slice(0, separator), rawValue];
        }
      })
  );
}

function getSessionToken(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[appConfig.authCookieName];
}

function cookieAttributes(maxAge: number): string {
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    appConfig.authCookieSecure ? "Secure" : ""
  ]
    .filter(Boolean)
    .join("; ");
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.header(
    "Set-Cookie",
    `${appConfig.authCookieName}=${encodeURIComponent(token)}; ${cookieAttributes(appConfig.authSessionTtlSeconds)}`
  );
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header("Set-Cookie", `${appConfig.authCookieName}=; ${cookieAttributes(0)}`);
}

function safeNextPath(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  return value;
}

async function renderView(name: string, data: Record<string, unknown>): Promise<string> {
  return ejs.renderFile(path.join(viewsDir, `${name}.ejs`), {
    ...data,
    currentUser: data.currentUser ?? null,
    config: appConfig,
    formatDate(value?: string | Date) {
      if (!value) {
        return "-";
      }

      const date = typeof value === "string" ? new Date(value) : value;
      return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("ko-KR", { hour12: false });
    },
    formatBytes(value: number) {
      if (value < 1024) {
        return `${value} B`;
      }

      if (value < 1024 * 1024) {
        return `${(value / 1024).toFixed(1)} KB`;
      }

      if (value < 1024 * 1024 * 1024) {
        return `${(value / 1024 / 1024).toFixed(1)} MB`;
      }

      return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
    }
  }) as Promise<string>;
}

function redirect(reply: FastifyReply, location: string): FastifyReply {
  return reply.code(303).header("Location", location).send();
}

export function buildServer(store: BackupTargetStore, authStore: AuthStore): FastifyInstance {
  const app = fastify({ logger: true });

  void app.register(formbody);

  app.addHook("preHandler", async (request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (publicPaths.has(pathname)) {
      return;
    }

    const token = getSessionToken(request.headers.cookie);
    const session = token ? await authStore.getSession(token) : null;
    if (!token || !session) {
      clearSessionCookie(reply);
      const next = request.method === "GET" ? `?next=${encodeURIComponent(request.url)}` : "";
      return redirect(reply, `/login${next}`);
    }

    request.authUser = session.username;
    request.sessionToken = token;
  });

  app.get("/healthz", async () => ({ ok: true, mode: appConfig.mode }));

  app.get("/styles.css", async (_request, reply) => {
    const css = await readFile(stylesPath, "utf8");
    return reply.type("text/css; charset=utf-8").send(css);
  });

  app.get("/login", async (request, reply) => {
    const query = request.query as { next?: string; error?: string; notice?: string };
    const token = getSessionToken(request.headers.cookie);
    const session = token ? await authStore.getSession(token) : null;
    if (session) {
      return redirect(reply, safeNextPath(query.next));
    }

    const html = await renderView("login", {
      errors: query.error ? [query.error] : [],
      notice: query.notice,
      next: safeNextPath(query.next),
      username: ""
    });

    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/login", async (request, reply) => {
    const body = (request.body ?? {}) as FormBody;
    const username = firstValue(body, "username").trim();
    const password = firstValue(body, "password");
    const next = safeNextPath(firstValue(body, "next"));

    if (!username || !password) {
      const html = await renderView("login", {
        errors: ["계정과 비밀번호를 입력하세요."],
        notice: null,
        next,
        username
      });

      return reply.code(400).type("text/html; charset=utf-8").send(html);
    }

    const user = await authStore.getUser();
    if (!user) {
      const html = await renderView("login", {
        errors: ["관리자 계정이 아직 Redis에 생성되지 않았습니다. README의 초기 계정 생성 명령을 먼저 실행하세요."],
        notice: null,
        next,
        username
      });

      return reply.code(503).type("text/html; charset=utf-8").send(html);
    }

    const verified = await authStore.verifyPassword(username, password);
    if (!verified) {
      const html = await renderView("login", {
        errors: ["계정 또는 비밀번호가 올바르지 않습니다."],
        notice: null,
        next,
        username
      });

      return reply.code(401).type("text/html; charset=utf-8").send(html);
    }

    setSessionCookie(reply, await authStore.createSession(username));
    return redirect(reply, next);
  });

  app.post("/logout", async (request, reply) => {
    if (request.sessionToken) {
      await authStore.deleteSession(request.sessionToken);
    }

    clearSessionCookie(reply);
    return redirect(reply, "/login?notice=%EB%A1%9C%EA%B7%B8%EC%95%84%EC%9B%83%ED%96%88%EC%8A%B5%EB%8B%88%EB%8B%A4.");
  });

  app.get("/", async (request, reply) => {
    const query = request.query as { notice?: string; error?: string };
    const targets = await store.listTargets();
    const html = await renderView("index", {
      targets,
      notice: query.notice,
      error: query.error,
      currentUser: request.authUser
    });

    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/targets/new", async (_request, reply) => {
    const html = await renderView("target-form", {
      title: "백업 대상 추가",
      action: "/targets",
      submitLabel: "추가",
      errors: [],
      currentUser: _request.authUser,
      target: {
        name: "",
        host: "127.0.0.1",
        port: 3306,
        database: "",
        username: "",
        password: "",
        enabled: true
      } satisfies BackupTargetInput
    });

    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/targets", async (request, reply) => {
    const body = (request.body ?? {}) as FormBody;
    const { input, errors } = parseTargetInput(body);
    if (!input) {
      const html = await renderView("target-form", {
        title: "백업 대상 추가",
        action: "/targets",
        submitLabel: "추가",
        errors,
        target: body,
        currentUser: request.authUser
      });

      return reply.code(400).type("text/html; charset=utf-8").send(html);
    }

    await store.saveTarget(input);
    return redirect(reply, "/?notice=%EB%B0%B1%EC%97%85%20%EB%8C%80%EC%83%81%EC%9D%84%20%EC%B6%94%EA%B0%80%ED%96%88%EC%8A%B5%EB%8B%88%EB%8B%A4.");
  });

  app.get("/targets/:id/edit", async (request, reply) => {
    const { id } = request.params as { id: string };
    const target = await store.getTarget(id);
    if (!target) {
      return reply.code(404).send("Not found");
    }

    const html = await renderView("target-form", {
      title: "백업 대상 수정",
      action: `/targets/${encodeURIComponent(id)}`,
      submitLabel: "저장",
      errors: [],
      target: targetToInput(target),
      currentUser: request.authUser
    });

    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/targets/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await store.getTarget(id);
    if (!existing) {
      return reply.code(404).send("Not found");
    }

    const body = (request.body ?? {}) as FormBody;
    const { input, errors } = parseTargetInput(body);
    if (!input) {
      const html = await renderView("target-form", {
        title: "백업 대상 수정",
        action: `/targets/${encodeURIComponent(id)}`,
        submitLabel: "저장",
        errors,
        target: body,
        currentUser: request.authUser
      });

      return reply.code(400).type("text/html; charset=utf-8").send(html);
    }

    await store.saveTarget(input, id);
    return redirect(reply, "/?notice=%EB%B0%B1%EC%97%85%20%EB%8C%80%EC%83%81%EC%9D%84%20%EC%A0%80%EC%9E%A5%ED%96%88%EC%8A%B5%EB%8B%88%EB%8B%A4.");
  });

  app.post("/targets/:id/delete", async (request, reply) => {
    const { id } = request.params as { id: string };
    await store.deleteTarget(id);
    return redirect(reply, "/?notice=%EB%B0%B1%EC%97%85%20%EB%8C%80%EC%83%81%EC%9D%84%20%EC%82%AD%EC%A0%9C%ED%96%88%EC%8A%B5%EB%8B%88%EB%8B%A4.");
  });

  app.get("/targets/:id/files", async (request, reply) => {
    const { id } = request.params as { id: string };
    const target = await store.getTarget(id);
    if (!target) {
      return reply.code(404).send("Not found");
    }

    const files = await listBackupFiles(appConfig.backupRoot, target.database);
    const html = await renderView("files", { target, files, currentUser: request.authUser });
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/password", async (request, reply) => {
    const query = request.query as { notice?: string };
    const html = await renderView("password", {
      errors: [],
      notice: query.notice,
      currentUser: request.authUser
    });

    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/password", async (request, reply) => {
    const body = (request.body ?? {}) as FormBody;
    const currentPassword = firstValue(body, "currentPassword");
    const nextPassword = firstValue(body, "nextPassword");
    const confirmPassword = firstValue(body, "confirmPassword");
    const errors: string[] = [];

    if (!currentPassword) {
      errors.push("현재 비밀번호를 입력하세요.");
    }

    if (nextPassword.length < 8) {
      errors.push("변경할 비밀번호는 8자 이상이어야 합니다.");
    }

    if (nextPassword !== confirmPassword) {
      errors.push("변경할 비밀번호와 확인 값이 일치하지 않습니다.");
    }

    if (errors.length === 0) {
      const changed = await authStore.changePassword(request.authUser || "", currentPassword, nextPassword);
      if (!changed) {
        errors.push("현재 비밀번호가 올바르지 않습니다.");
      }
    }

    if (errors.length > 0) {
      const html = await renderView("password", {
        errors,
        notice: null,
        currentUser: request.authUser
      });

      return reply.code(400).type("text/html; charset=utf-8").send(html);
    }

    if (request.sessionToken) {
      await authStore.deleteSession(request.sessionToken);
    }

    setSessionCookie(reply, await authStore.createSession(request.authUser || ""));
    return redirect(reply, "/password?notice=%EB%B9%84%EB%B0%80%EB%B2%88%ED%98%B8%EB%A5%BC%20%EB%B3%80%EA%B2%BD%ED%96%88%EC%8A%B5%EB%8B%88%EB%8B%A4.");
  });

  app.addHook("onClose", async () => {
    await store.close();
    await authStore.close();
  });

  return app;
}

async function main(): Promise<void> {
  const store = await createBackupTargetStore();
  const authStore = await createAuthStore();
  const app = buildServer(store, authStore);

  await app.listen({
    host: appConfig.webHost,
    port: appConfig.webPort
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
