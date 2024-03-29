import { get, ref, set, update } from 'firebase/database';
import { DateTime } from 'luxon';
import type { NextApiRequest, NextApiResponse } from 'next';
import { rtdb } from 'src/lib/firebase/rdtb';

type Data = {
  result: string;
};

type ExpectedRequestBody = Partial<{
  hostname: string;
  pluginNames: string[];
  page: string;
  email: string;
  appName: string;
}>;

export default async (req: NextApiRequest, res: NextApiResponse<Data>) => {
  try {
    if (req.method === 'POST') {
      const body: ExpectedRequestBody = JSON.parse(req.body);

      let causedError = false;
      try {
        await updateRtdb(body);
      } catch (error) {
        console.error('realtime database更新時にエラーが発生しました', error);
        causedError = true;
      }
      try {
        updateSummary();
      } catch (error) {
        console.error('集計情報をDBに登録する際にエラーが発生しました');
      }
      if (!causedError) {
        res.status(200).json({ result: `データベースへ追加しました` });
      } else {
        await postToGAS(body);
        res.status(500).json({
          result: `予期せぬエラーが発生しました。`,
        });
      }
    }
  } catch (e) {
    res.status(500).json({ result: `予期せぬエラーが発生しました。${JSON.stringify(e)}` });
    throw 'API実行時にエラーが発生しました';
  }
};

const updateRtdb = async (body: ExpectedRequestBody) => {
  const hostname = body.hostname || '___undefined';

  const formattedHostname = hostname
    .replace(/(\.s)?\.(cybozu|kintone)\.com/, '')
    .replace(/\./g, '_dot_');

  const now = DateTime.local();

  try {
    await updateUser(formattedHostname, body);
  } catch (error) {
    console.error('ユーザー情報の更新に失敗しました');
  }

  // try {
  //   await updateEmails(formattedHostname, body.email || '');
  // } catch (error) {
  //   console.error('メールアドレスの更新に失敗しました');
  // }

  // try {
  //   await updateAppNames(formattedHostname, body.appName || '');
  // } catch (error) {
  //   console.error('アプリ名の更新に失敗しました');
  // }

  try {
    await updateCounter(formattedHostname);
  } catch (error) {
    console.error('カウンターの更新に失敗しました');
  }

  try {
    await updateInstallDate(formattedHostname, now);
  } catch (error) {
    console.error('インストール日付の更新に失敗しました');
  }

  try {
    await set(ref(rtdb, `kintone/lastModified/${formattedHostname}`), now.toISODate());
  } catch (error) {
    console.error('更新日付の更新に失敗しました');
  }
};

const updateUser = async (hostname: string, body: ExpectedRequestBody) => {
  const reference = ref(rtdb, `kintone/users/${hostname}`);

  const snapshot = await get(reference);

  if (!snapshot.exists()) {
    await set(reference, {
      name: '',
      pluginNames: body.pluginNames || [],
    });
  } else {
    const data = snapshot.val();

    const pluginNames = body.pluginNames || [];
    const registered: string[] = data.pluginNames || [];

    const noChanges = pluginNames.every((plugin) => registered.includes(plugin));

    if (!noChanges) {
      await update(reference, {
        pluginNames: [...new Set([...pluginNames, ...registered])],
      });
    }
  }
};

const updateEmails = async (hostname: string, email: string) => {
  if (!email) {
    return;
  }

  const emailRef = ref(rtdb, `kintone/email/${hostname}`);
  const snapshot = await get(emailRef);

  if (!snapshot.exists()) {
    await set(emailRef, [email]);
    return;
  }

  const registered: string[] = snapshot.val();

  if (registered.includes(email)) {
    return;
  }

  await set(emailRef, [...registered, email]);
};

const updateAppNames = async (hostname: string, appName: string) => {
  if (!appName) {
    return;
  }

  const reference = ref(rtdb, `kintone/appName/${hostname}`);
  const snapshot = await get(reference);

  if (!snapshot.exists()) {
    await set(reference, [appName]);
    return;
  }

  const registered: string[] = snapshot.val();

  if (registered.includes(appName)) {
    return;
  }

  await set(reference, [...registered, appName]);
};

const updateCounter = async (hostname: string) => {
  const counterRef = ref(rtdb, `kintone/counter/${hostname}`);
  const counterSnapshot = await get(counterRef);

  if (counterSnapshot.exists()) {
    await set(counterRef, Number(counterSnapshot.val()) + 1);
  } else {
    await set(counterRef, 1);
  }
};

const updateInstallDate = async (hostname: string, now: DateTime) => {
  const installDateRef = ref(rtdb, `kintone/installDate/${hostname}`);
  const installDateSnapshot = await get(installDateRef);

  if (!installDateSnapshot.exists()) {
    await set(installDateRef, now.toISODate());
  }
};

const postToGAS = (body: ExpectedRequestBody) => {
  if (!process.env.GAS_END_POINT) {
    console.log('GAS WebアプリケーションのURLが登録されていません');
    return;
  }
  return fetch(process.env.GAS_END_POINT, {
    method: 'POST',
    body: JSON.stringify({
      ...body,
      from: 'ribbit-next-app',
    }),
  });
};

const updateSummary = async () => {
  const now = DateTime.local().plus({ hours: 9 });
  const summaryRef = ref(rtdb, `kintone/summary/${now.toISODate()}`);

  const summarySnapshot = await get(summaryRef);

  if (summarySnapshot.exists()) {
    return;
  }

  const counterRef = ref(rtdb, 'kintone/counter');
  const counterSnapshot = await get(counterRef);

  if (!counterSnapshot.exists()) {
    console.error('カウンターの取得に失敗しました');
    return;
  }

  const data: Record<string, number> = counterSnapshot.val();

  const counters = Object.values(data);

  const sum = counters.reduce((acc, count) => acc + count, 0);

  const unixTime = now.toUnixInteger();
  await set(summaryRef, { unixTime, numUsers: counters.length, counter: sum });
};
