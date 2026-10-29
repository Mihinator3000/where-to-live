# Мировые данные: data/world

Два готовых JSON, которые приложение читает статикой. Собираются скриптами отсюда; в браузере ничего не качается.

## indicators.json — показатели по странам

`scripts/build_countries.py`, ~30 с, только стандартная библиотека Python.

- Ключ страны — ISO3 как в Natural Earth: `ISO_A3_EH`, а если там `-99` — `ADM0_A3` (Косово `KOS`, Сев. Кипр `CYN`). World Bank `XKX` и OWID `OWID_KOS` приводятся к `KOS`; агрегаты WB и регионы OWID отброшены.
- Значение — `[число, год]`; у `ru_visa` третий элемент — режим въезда (`visa free`, `visa on arrival`, `eta`, `e-visa`, `visa required`, `no admission`, `home`).
- Источники:
  - World Bank WDI (CC BY 4.0), API `api.worldbank.org/v2`, `mrnev=1`: ВВП ППС, уровень цен `PA.NUS.PRVT.PLI` (по стране, не по городу), инфляция (среднее за 5 последних доступных лет, `mrnev=5`), безработица, продолжительность жизни, UHC `SH_UHC_SCI`, PM2.5, убийства, интернет.
  - World Bank WGI, `source=3`, коды `GOV_WGI_*.EST` (бывает, отвечает ~50 с): стабильность, верховенство права, коррупция, госуправление.
  - Our World in Data grapher CSV: HDI (UNDP, CC BY 3.0 IGO), счастье (World Happiness Report), электоральная демократия (V-Dem, CC BY 4.0). Берётся последний год по стране.
  - INFORM Risk (EC JRC): общий риск `INFORM` (`inform_risk`) и природные угрозы `HA.NAT` (`inform_nat`), 0–10. Workflow ищется сам: последний `INFORM Risk <год>` в `workflows/GetByWorkflowGroup/INFORM<год>`. API рвёт соединения — в скрипте ретраи.
  - passport-index-data (MIT, github.com/imorte/passport-index-data, данные с passportindex.org): `ru_visa` — дни безвиза для паспорта РФ (`visa free` без срока → 90, `visa on arrival` → 30, `eta` → 90, виза и e-visa → 0; Россия = 360, «home»); `passport_power` — число стран без визы/VOA/eTA для паспорта этой страны.
- Шкала 1–5 (`scale`), Россия = 3: `log` — 3 + dir·ln(x/x_RUS)/step, `lin` — 3 + dir·(x − x_RUS)/step, `abs` — кусочно-линейно по порогам; клип делает приложение.
- `cats` — подкатегории методики, для которых показатель служит колонкой «данные». У части показателей есть поле `note` — оговорка для подсказки.

## cities.json — города и климат

`scripts/build_cities.py`, зависимости `rasterio`, `tzdata`. Полный прогон локально — 21 мин (CHELSA 39 файлов × 4719 точек, 1 км, 16 потоков — 20 мин; упирается в задержку HTTP, не в CPU). `--level 0` читает overview 2 км: вдвое быстрее, разница tas в среднем 0,05 °C, максимум 0,7 °C (kg0 всегда с 1 км).

- Набор (4719 городов): GeoNames `cities15000` с населением ≥ 200 тыс.; в странах фокуса (ME RS TR GE AM CY GR HR AL BA MK BG SI ES PT IT KZ AZ) — от 15 тыс., но в ES, IT, TR от 22 тыс.: иначе файл больше 1,5 МБ (выкинуто ES 191, IT 203, TR 90 городов на 15–22 тыс.); Россия от 100 тыс.; Черногория — все `cities1000` (41). Районы и исторические пункты (`PPLX`, `PPLH`, `PPLQ`, `PPLW`) выкинуты.
- `n` — `rdfs:label@ru` из Wikidata: сначала по GeoNames ID (P1566), батчами по 300; у многих крупных городов P1566 указывает на муниципалитет или ADM2, поэтому второй проход — элемент с тем же `@en`/`@mul` названием и координатами в пределах 25 км. Скобки-уточнения и «район/городской округ» срезаются. Нет — латинское имя GeoNames (~10%, в основном мелкие города Италии и Испании). Единичные промахи возможны (Halle → «Галле (Зале)-Главный»).
- Климат — CHELSA V2.1 climatologies 1981–2010 (CC0), COG по HTTP Range с `os.unil.cloud.switch.ch/chelsa02/chelsa/global/`:
  - `t` — tas по месяцам, °C (в файле K, шкала 0.1); `tx` — tasmax июля; `tn` — tasmin января;
  - `p` — pr по месяцам, мм/мес (kg m⁻² month⁻¹, шкала 0.1);
  - `c` — clt по месяцам, % (шкала 0.01; сетка 0.025°, ~3 км);
  - `kg` — kg0 (Köppen-Geiger), коды 1–31 в порядке Kottek: Af Am As Aw BWk BWh BSk BSh Cfa Cfb Cfc Csa Csb Csc Cwa Cwb Cwc Dfa Dfb Dfc Dfd Dsa Dsb Dsc Dsd Dwa Dwb Dwc Dwd EF ET. Легенда проверена пересчётом классов из tas/pr тех же городов: совпадение 93% по классу, 99,7% по главной букве (расходятся пограничные Cfa/Csa и As/Aw).
  - Осадки CHELSA у гор над побережьем завышены (Будва ~2400 мм/год против ~1600 по станции): сравнивать места между собой можно, абсолют — с оговоркой.
  - Точка в море (nodata) — ближайший пиксель суши в окне 5×5.
- `el` — высота GeoNames (`elevation`, нет — `dem`); `tz` — смещение от Москвы (UTC+3) в местную зиму (15 января, в южном полушарии 15 июля), ч; `air` — км до ближайшего `large_airport` OurAirports (public domain); `cc` — ISO3 по Natural Earth `ISO_A2_EH`.
- Размер: 1,46 МБ, gzip 0,49 МБ.

## Как перезапустить

Локально:

```
uv run python scripts/build_countries.py
uv run --with rasterio --with tzdata python scripts/build_cities.py --workers 16
```

Кэш скачанного — во временной папке (`--cache`). Сэмплы CHELSA кэшируются по растру и по точке: прерванный прогон продолжается с места, а после правки списка городов досэмплируются только новые точки.

В GitHub: Actions → world-data → Run workflow (галка `cities` — пересобрать и города). По расписанию 5-го числа в 03:00 UTC обновляются только страны; коммит — только если данные изменились.
