import { isAbsolute, join } from "node:path";
import { PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Reads a file named on the command line by an agent thread. The CLI runs on the server, and the file lives on the
 * invoking thread's machine. A relative path resolves against the invocation's working directory.
 */
export async function readThreadFile(
  bb: BbPluginApi,
  request: { threadId: string; cwd: string | undefined; path: string; errorCode: string },
): Promise<string> {
  const { threadId, cwd, path, errorCode } = request;
  const absolute = isAbsolute(path) ? path : cwd ? join(cwd, path) : null;
  if (absolute === null) {
    throw new PluginCliError(`cannot resolve the relative path ${path} without a working directory`, {
      code: errorCode,
      hint: 'Pass an absolute path, such as --file "$BB_THREAD_STORAGE/plan.json".',
    });
  }
  const thread = await bb.sdk.threads.get({ threadId });
  const hostId = thread.environmentId ? (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId : undefined;
  try {
    const file = await bb.sdk.files.read({ ...(hostId ? { hostId } : {}), path: absolute });
    return file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
  } catch (error) {
    throw new PluginCliError(`cannot read ${absolute}: ${error instanceof Error ? error.message : String(error)}`, { code: errorCode });
  }
}
