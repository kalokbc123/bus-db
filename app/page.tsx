'use client';

import { useState, useEffect, useCallback } from 'react';

// 字串正規化：統一全角/半角括號並去除空格與大小寫
const cleanStr = (str: string) =>
  str
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/\s+/g, '')
    .toLowerCase();

// API 工具
async function fetchApi(url: string, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

interface LegRouteConfig {
  route: string;
  stopKeywords: string[];
}

interface LegConfig {
  id: string;
  title: string;
  displayStopName: string;
  configs: LegRouteConfig[];
}

// 4 段路程配置（包含 91、91M、91P 全部組合）
const COMMUTE_CONFIG: Record<'outbound' | 'inbound', LegConfig[]> = {
  outbound: [
    {
      id: 'out-1',
      title: '第一程：88 號巴士',
      displayStopName: '田園閣 (ST221)',
      configs: [
        { route: '88', stopKeywords: ['田園閣'] }
      ],
    },
    {
      id: 'out-2',
      title: '第二程：91 / 91M 號巴士',
      displayStopName: '牛池灣村 (WT214)',
      configs: [
        { route: '91', stopKeywords: ['牛池灣村'] },
        { route: '91M', stopKeywords: ['牛池灣村'] },
      ],
    },
  ],
  inbound: [
    {
      id: 'in-1',
      title: '第一程：91 / 91M / 91P 號巴士',
      displayStopName: '香港科技大學(南) (SK950)',
      configs: [
        { route: '91', stopKeywords: ['香港科技大學', '科大'] },
        { route: '91M', stopKeywords: ['香港科技大學', '科大'] },
        { route: '91P', stopKeywords: ['香港科技大學', '科大'] },
      ],
    },
    {
      id: 'in-2',
      title: '第二程：88 號巴士 (往大圍)',
      displayStopName: '牛池灣轉車站-彩虹站 (WT891)',
      configs: [
        { route: '88', stopKeywords: ['牛池灣轉車站', '彩虹站', '彩虹'] },
      ],
    },
  ],
};

interface EtaDetail {
  route: string;
  dest_tc: string;
  eta: string | null;
  rmk_tc: string;
}

export default function PerfectBusDashboard() {
  const [activeTab, setActiveTab] = useState<'outbound' | 'inbound'>('outbound');
  // key: "legId_route", value: exact stopId
  const [resolvedStopMap, setResolvedStopMap] = useState<Record<string, string>>({});
  const [etaData, setEtaData] = useState<Record<string, EtaDetail[]>>({});
  
  const [initializing, setInitializing] = useState(true);
  const [loadingEta, setLoadingEta] = useState(false);
  const [lastUpdated, setLastUpdated] = useState('');

  // 步驟 1：雙向自動探索 Stop ID，徹底解決 91P / 91M 方向問題
  useEffect(() => {
    const resolveStops = async () => {
      setInitializing(true);
      try {
        // 下載全港車站字典
        const allStopsRes = await fetchApi('https://data.etabus.gov.hk/v1/transport/kmb/stop');
        const allStopsMap = new Map<string, string>();
        (allStopsRes.data || []).forEach((s: any) => {
          allStopsMap.set(s.stop, s.name_tc || '');
        });

        const newMap: Record<string, string> = {};
        const allLegs = [...COMMUTE_CONFIG.outbound, ...COMMUTE_CONFIG.inbound];

        for (const leg of allLegs) {
          for (const cfg of leg.configs) {
            const mapKey = `${leg.id}_${cfg.route}`;
            const searchDirections: Array<'outbound' | 'inbound'> = ['outbound', 'inbound'];
            let matchedStopId = '';

            // 雙向比對：先試 outbound，若無則試 inbound（防止 91P 等特快線方向定義相反）
            for (const dir of searchDirections) {
              if (matchedStopId) break;
              try {
                const routeStopsRes = await fetchApi(
                  `https://data.etabus.gov.hk/v1/transport/kmb/route-stop/${cfg.route}/${dir}/1`
                );
                const routeStops = routeStopsRes.data || [];

                for (const item of routeStops) {
                  const rawName = allStopsMap.get(item.stop) || '';
                  const cleanedName = cleanStr(rawName);

                  const isMatch = cfg.stopKeywords.some((kw) => cleanedName.includes(cleanStr(kw)));
                  if (isMatch) {
                    matchedStopId = item.stop;
                    break;
                  }
                }
              } catch {
                // 忽略單向無效請求
              }
            }

            if (matchedStopId) {
              newMap[mapKey] = matchedStopId;
            }
          }
        }

        setResolvedStopMap(newMap);
      } catch (err) {
        console.error('車站定位失敗:', err);
      } finally {
        setInitializing(false);
      }
    };

    resolveStops();
  }, []);

  // 步驟 2：獲取實時到站 ETA（移除 dir 過濾，直接依據車牌及站點讀取）
  const fetchAllEtas = useCallback(async () => {
    if (Object.keys(resolvedStopMap).length === 0) return;
    setLoadingEta(true);

    const results: Record<string, EtaDetail[]> = {};
    const currentLegs = [...COMMUTE_CONFIG.outbound, ...COMMUTE_CONFIG.inbound];

    await Promise.all(
      currentLegs.map(async (leg) => {
        const legEtas: EtaDetail[] = [];

        await Promise.all(
          leg.configs.map(async (cfg) => {
            const mapKey = `${leg.id}_${cfg.route}`;
            const stopId = resolvedStopMap[mapKey];
            if (!stopId) return;

            try {
              const res = await fetchApi(`https://data.etabus.gov.hk/v1/transport/kmb/stop-eta/${stopId}`);
              const rawEtas = res.data || [];

              // 直接匹配路線號碼與有 valid ETA 的車次，不再限制 dir
              const matched = rawEtas.filter(
                (item: any) => item.route === cfg.route && item.eta
              );

              matched.forEach((item: any) => {
                legEtas.push({
                  route: item.route,
                  dest_tc: item.dest_tc,
                  eta: item.eta,
                  rmk_tc: item.rmk_tc,
                });
              });
            } catch (err) {
              console.error(`Fetch ETA Error [${mapKey}]:`, err);
            }
          })
        );

        // 去除重複班次並依時間由近至遠排序
        const uniqueEtas = Array.from(
          new Map(legEtas.map((item) => [`${item.route}_${item.eta}`, item])).values()
        );
        uniqueEtas.sort((a, b) => new Date(a.eta!).getTime() - new Date(b.eta!).getTime());

        results[leg.id] = uniqueEtas;
      })
    );

    setEtaData(results);
    setLastUpdated(new Date().toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    setLoadingEta(false);
  }, [resolvedStopMap]);

  useEffect(() => {
    if (!initializing) {
      fetchAllEtas();
      const timer = setInterval(fetchAllEtas, 20000); // 20 秒自動更新
      return () => clearInterval(timer);
    }
  }, [initializing, fetchAllEtas]);

  return (
    <main className="min-h-screen bg-gray-100 p-4 md:p-8">
      <div className="max-w-xl mx-auto space-y-4">
        
        {/* 頁頭 */}
        <div className="bg-white p-4 rounded-xl shadow flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold text-gray-800">燒味返工放工巴士時間表</h1>
            {lastUpdated && <p className="text-xs text-gray-500 mt-1">最後更新：{lastUpdated}</p>}
          </div>
          <button
            onClick={fetchAllEtas}
            disabled={loadingEta || initializing}
            className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition disabled:opacity-50"
          >
            {loadingEta ? '更新中...' : '手動刷新'}
          </button>
        </div>

        {/* 去程 / 回程 切換頁籤 */}
        <div className="flex bg-gray-200 p-1 rounded-xl">
          <button
            onClick={() => setActiveTab('outbound')}
            className={`flex-1 py-2 text-center font-bold text-sm rounded-lg transition ${
              activeTab === 'outbound' ? 'bg-white text-red-600 shadow' : 'text-gray-600'
            }`}
          >
            去程：田園閣 ➔ 科大(北)
          </button>
          <button
            onClick={() => setActiveTab('inbound')}
            className={`flex-1 py-2 text-center font-bold text-sm rounded-lg transition ${
              activeTab === 'inbound' ? 'bg-white text-red-600 shadow' : 'text-gray-600'
            }`}
          >
            回程：科大(南) ➔ 田園閣
          </button>
        </div>

        {/* 內容區域 */}
        {initializing ? (
          <div className="bg-white p-8 rounded-xl shadow text-center space-y-2">
            <div className="text-red-600 font-bold animate-pulse">正在精準對應所有路線車站...</div>
            <p className="text-xs text-gray-400">已啟用雙向自動偵測，請稍候 1 秒。</p>
          </div>
        ) : (
          <div className="space-y-4">
            {COMMUTE_CONFIG[activeTab].map((leg) => {
              const etas = etaData[leg.id] || [];

              return (
                <div key={leg.id} className="bg-white p-5 rounded-xl shadow border border-gray-100 space-y-3">
                  <div className="border-b pb-2">
                    <span className="text-xs font-bold text-red-600 bg-red-50 px-2 py-0.5 rounded">
                      {leg.title}
                    </span>
                    <h2 className="text-lg font-bold text-gray-800 mt-1">{leg.displayStopName}</h2>
                  </div>

                  {loadingEta && etas.length === 0 ? (
                    <p className="text-sm text-gray-400 py-4 text-center animate-pulse">更新到站時間中...</p>
                  ) : etas.length === 0 ? (
                    <p className="text-sm text-gray-500 py-4 text-center bg-gray-50 rounded-lg">
                      暫無預計到站班次
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {etas.slice(0, 3).map((item, idx) => {
                        const etaTime = new Date(item.eta!).getTime();
                        const now = new Date().getTime();
                        const diffMins = Math.max(0, Math.floor((etaTime - now) / 60000));

                        return (
                          <div
                            key={idx}
                            className={`p-3 rounded-lg border text-center ${
                              idx === 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-100'
                            }`}
                          >
                            <div className="flex justify-between items-center text-xs text-gray-500 mb-1">
                              <span className="font-bold text-gray-800">{item.route} 號</span>
                              <span>往 {item.dest_tc}</span>
                            </div>
                            
                            <div className={`text-xl font-black ${idx === 0 ? 'text-red-600' : 'text-gray-700'}`}>
                              {diffMins === 0 ? '即將到達' : `${diffMins} 分鐘`}
                            </div>

                            <div className="text-[14px] text-black-400 mt-1">
                              {new Date(item.eta!).toLocaleTimeString('zh-HK', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                              {item.rmk_tc && ` (${item.rmk_tc})`}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}