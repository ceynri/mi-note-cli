import { ensureAuth, peekAuth, clearAuthCache } from "../auth.js";
import { success, logInfo, fail } from "../output.js";

/** login：强制走登录流程（浏览器或导入），刷新缓存 */
export async function loginCommand(): Promise<void> {
  try {
    const auth = await ensureAuth(true);
    success({ userId: auth.userId, loggedIn: true }, () => {
      logInfo(`✅ 登录成功${auth.userId ? `（userId: ${auth.userId}）` : ""}`);
    });
  } catch (err) {
    fail(err);
  }
}

/** logout：清除本工具缓存 */
export async function logoutCommand(): Promise<void> {
  try {
    await clearAuthCache();
    success({ loggedOut: true }, () => {
      logInfo("✅ 已清除登录态与缓存");
    });
  } catch (err) {
    fail(err);
  }
}

/** whoami：查看当前登录态 */
export async function whoamiCommand(): Promise<void> {
  try {
    const auth = await peekAuth();
    if (!auth) {
      success({ loggedIn: false }, () => {
        logInfo("未登录（运行 mi-note-cli login 登录）");
      });
      return;
    }
    success({ loggedIn: true, userId: auth.userId }, () => {
      logInfo(`已登录${auth.userId ? `，userId: ${auth.userId}` : ""}`);
    });
  } catch (err) {
    fail(err);
  }
}
