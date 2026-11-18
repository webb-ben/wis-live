// Environment Canada citypage weather (MSC, siteData schema): the current
// conditions, the forecast, warnings and the next hours as a chart
import { esc, svgEl } from '../lib/util.js';

// resized(): the panel's height changed (a tab was picked)
export function renderCitypage(out, title, doc, resized) {
    var q = (el, sel) => (el ? el.querySelector(sel) : null);
    var tx = (el, sel) => {
        var n = sel ? q(el, sel) : el;
        var t = n && n.textContent.trim();
        return t || null;
    };
    // Local time of a named dateTime, e.g. "11:30 NDT"
    var local = (parent, name) => {
        var all = [...(parent ? parent.querySelectorAll(`:scope > dateTime[name="${name}"]`) : [])];
        var d = all.find((n) => n.getAttribute('zone') !== 'UTC') || all[0];
        return d ? `${tx(d, 'hour')}:${tx(d, 'minute')} ${d.getAttribute('zone')}` : null;
    };
    var unit = (n) => (n && n.getAttribute('units') ? ` ${n.getAttribute('units')}` : '');
    var withUnit = (el, sel) => {
        var n = q(el, sel), t = tx(n);
        return t === null ? null : `${t}${unit(n).replace(' C', ' °C')}`;
    };

    var place = tx(doc, 'location > name');
    var region = [tx(doc, 'location > region'), tx(doc, 'location > province')].filter(Boolean).join(', ');
    if (title && place) title.textContent = place;

    // Warnings and watches in effect
    var warnings = [...doc.querySelectorAll('warnings > event')].map((e) => ({
        type: e.getAttribute('type') || '',
        priority: e.getAttribute('priority') || '',
        text: e.getAttribute('description') || tx(e, 'textSummary') || '',
    }));
    var warningsUrl = q(doc, 'warnings') && q(doc, 'warnings').getAttribute('url');

    // Current conditions
    var cc = q(doc, 'currentConditions');
    var temp = tx(cc, ':scope > temperature');
    var pressure = q(cc, ':scope > pressure');
    var tendency = pressure && pressure.getAttribute('tendency');
    var wind = q(cc, ':scope > wind');
    var windText = wind && tx(wind, 'speed') ? [
        tx(wind, 'direction'), `${tx(wind, 'speed')} km/h`, tx(wind, 'gust') ? `gusting ${tx(wind, 'gust')}` : null,
    ].filter(Boolean).join(' ') : null;
    var station = tx(cc, 'station');

    // Forecast periods
    var periods = [...doc.querySelectorAll('forecastGroup > forecast')].map((f) => {
        var period = q(f, ':scope > period');
        var t = q(f, 'temperatures > temperature');
        return {
            name: (period && period.getAttribute('textForecastName')) || tx(period),
            short: tx(f, 'abbreviatedForecast > textSummary'),
            summary: tx(f, ':scope > textSummary'),
            pop: tx(f, 'abbreviatedForecast > pop'),
            temp: t && tx(t) !== null ? { value: tx(t), cls: t.getAttribute('class') } : null,
        };
    });

    // Hourly forecast, with hours shown in local time
    var issue = [...doc.querySelectorAll('hourlyForecastGroup > dateTime')].find((d) => d.getAttribute('zone') !== 'UTC');
    var offset = issue ? Number(issue.getAttribute('UTCOffset')) || 0 : 0;
    var hours = [...doc.querySelectorAll('hourlyForecastGroup > hourlyForecast')].map((h) => {
        var u = h.getAttribute('dateTimeUTC') || '';
        var time = new Date(Date.UTC(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8), +u.slice(8, 10), +u.slice(10, 12)));
        var t = tx(h, 'temperature');
        return {
            hour: new Date(time.getTime() + offset * 3600e3).getUTCHours(),
            temp: t === null ? null : Number(t),
            lop: Number(tx(h, 'lop')) || 0,
            condition: tx(h, 'condition'),
            wind: [tx(h, 'wind > direction'), tx(h, 'wind > speed') ? `${tx(h, 'wind > speed')} km/h` : null].filter(Boolean).join(' '),
        };
    }).filter((h) => h.temp !== null);

    var yesterday = q(doc, 'yesterdayConditions');
    var high = q(yesterday, 'temperature[class="high"]'), low = q(yesterday, 'temperature[class="low"]');
    var round = (n) => (tx(n) !== null ? Math.round(Number(tx(n))) : null);
    var sun = [local(q(doc, 'riseSet'), 'sunrise'), local(q(doc, 'riseSet'), 'sunset')];

    // Day and night periods share a row: "Friday  Mainly cloudy  7° / 2°"
    var days = [];
    for (var p of periods) {
        var last = days[days.length - 1];
        if (last && !last.night && p.temp && p.temp.cls === 'low' && (!last.temp || last.temp.cls === 'high')) {
            last.night = p;
        } else {
            days.push({ ...p, night: null });
        }
    }
    var degrees = (t) => (t ? `<span class="citypage-${esc(t.cls)}">${esc(t.value)}°</span>` : '');
    var now = cc && temp !== null ? [
        withUnit(cc, ':scope > dewpoint') ? `Dew point ${withUnit(cc, ':scope > dewpoint')}` : null,
        withUnit(cc, ':scope > relativeHumidity') ? `RH ${withUnit(cc, ':scope > relativeHumidity').replace(' %', '%')}` : null,
        pressure && tx(pressure) ? `${tx(pressure)} kPa${tendency ? ` ${{ rising: '↑', falling: '↓' }[tendency] || '→'}` : ''}` : null,
        windText,
        tx(cc, ':scope > windChill') ? `Wind chill ${tx(cc, ':scope > windChill')}` : null,
        tx(cc, ':scope > humidex') ? `Humidex ${tx(cc, ':scope > humidex')}` : null,
        withUnit(cc, ':scope > visibility') ? `Visibility ${withUnit(cc, ':scope > visibility')}` : null,
    ].filter(Boolean) : [];
    var extras = [
        ['Sunrise', sun[0]], ['Sunset', sun[1]],
        ['Yesterday', high || low ? [round(high) !== null ? `high ${round(high)}°` : null, round(low) !== null ? `low ${round(low)}°` : null].filter(Boolean).join(' · ') : null],
        ['Normals', tx(doc, 'regionalNormals > textSummary')],
        ['Forecast issued', local(q(doc, 'forecastGroup'), 'forecastIssue')],
    ].filter(([, v]) => v);
    var tabs = [
        hours.length > 1 ? ['hourly', 'Next hours'] : null,
        days.length ? ['forecast', 'Forecast'] : null,
        extras.length || periods.length ? ['details', 'Details'] : null,
    ].filter(Boolean);

    out.innerHTML = `
        <div class="citypage">
            ${!title && place ? `<div class="pp-name">${esc(place)}</div>` : ''}
            ${warnings.map((w) => `
            <div class="citypage-warning citypage-type-${esc(w.type.toLowerCase())}">
                <strong>${esc(w.text || w.type)}</strong>
                ${warningsUrl ? `<a href="${esc(warningsUrl)}" target="_blank" rel="noopener">Details</a>` : ''}
            </div>`).join('')}
            ${now.length ? `
            <div class="citypage-now">
                <div class="citypage-temp">${esc(Math.round(Number(temp)))}°</div>
                <div>
                    <div class="citypage-condition">${esc(tx(cc, ':scope > condition') || 'Now')}</div>
                    <div class="pp-status">${esc([station, local(cc, 'observation')].filter(Boolean).join(' · '))}</div>
                </div>
            </div>
            <div class="citypage-stats">${now.map(esc).join(' · ')}</div>` : region ? `<div class="pp-status">${esc(region)}</div>` : ''}
            ${tabs.length ? `
            <div class="citypage-tabs" role="tablist">${tabs.map(([key, label], i) => `
                <button type="button" role="tab" data-tab="${key}" aria-selected="${i === 0}">${label}</button>`).join('')}
            </div>
            <div class="citypage-panel" data-panel="hourly"><div class="citypage-hourly"></div></div>
            <div class="citypage-panel" data-panel="forecast">
                <ol class="citypage-periods">${days.map((d) => `
                    <li title="${esc([d.summary, d.night && `${d.night.name}: ${d.night.summary}`].filter(Boolean).join('\n\n'))}">
                        <span class="citypage-period">${esc(d.name || '')}</span>
                        <span class="citypage-short">${esc(d.short || '')}${d.pop ? ` <em>${esc(d.pop)}%</em>` : ''}</span>
                        <span class="citypage-hilo">${[degrees(d.temp), d.night ? degrees(d.night.temp) : ''].filter(Boolean).join(' / ')}</span>
                    </li>`).join('')}
                </ol>
            </div>
            <div class="citypage-panel" data-panel="details">
                ${extras.length ? `<dl class="citypage-extra">${extras.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
                ${periods.length ? `
                <details class="pp-more">
                    <summary>Full forecast text</summary>
                    <dl class="citypage-text">${periods.map((p) => `<dt>${esc(p.name || '')}</dt><dd>${esc(p.summary || '')}</dd>`).join('')}</dl>
                </details>` : ''}
            </div>` : ''}
        </div>`;
    if (hours.length > 1) renderHourly(out.querySelector('.citypage-hourly'), hours.slice(0, 24), { width: 300, height: 100 });
    var show = (key) => {
        out.querySelectorAll('.citypage-tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === key));
        out.querySelectorAll('.citypage-panel').forEach((panel) => { panel.hidden = panel.dataset.panel !== key; });
        resized();
    };
    out.querySelectorAll('.citypage-tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    if (tabs.length) show(tabs[0][0]);
}

// Temperature line over bars for the likelihood of precipitation, one per hour
export function renderHourly(container, hours, opts) {
    var W = opts.width, H = opts.height;
    var m = { top: 14, right: 8, bottom: 18, left: 8 };
    var w = W - m.left - m.right, h = H - m.top - m.bottom;
    var temps = hours.map((p) => p.temp);
    var tMin = Math.min(...temps), tMax = Math.max(...temps);
    if (tMax - tMin < 4) { tMin -= 2; tMax += 2; }
    var step = w / hours.length;
    var x = (i) => m.left + step * (i + 0.5);
    var yT = (t) => m.top + h * 0.7 * (tMax - t) / (tMax - tMin);
    var yL = (l) => m.top + h - h * 0.35 * l / 100;

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'hourly', role: 'img',
        'aria-label': 'Hourly temperature and chance of precipitation' });
    hours.forEach((p, i) => {
        if (p.lop) svgEl('rect', { x: x(i) - step / 2 + 1, y: yL(p.lop), width: step - 2, height: m.top + h - yL(p.lop), class: 'hourly-lop' }, svg);
        if (i % 3 === 0) svgEl('text', { x: x(i), y: H - 4, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = `${p.hour}h`;
    });
    svgEl('line', { x1: m.left, x2: m.left + w, y1: m.top + h, y2: m.top + h, class: 'skewt-tick' }, svg);
    svgEl('polyline', { points: hours.map((p, i) => `${x(i).toFixed(1)},${yT(p.temp).toFixed(1)}`).join(' '), class: 'hourly-temp' }, svg);
    // Label the warmest and coldest hours
    [temps.indexOf(Math.max(...temps)), temps.indexOf(Math.min(...temps))].forEach((i, k) => {
        svgEl('circle', { cx: x(i), cy: yT(hours[i].temp), r: 2.5, class: 'hourly-dot' }, svg);
        svgEl('text', { x: x(i), y: yT(hours[i].temp) + (k ? 12 : -5), class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = `${hours[i].temp}°`;
    });

    var readout = svgEl('text', { x: W - m.right, y: 10, class: 'skewt-readout', 'text-anchor': 'end' }, svg);
    var guide = svgEl('line', { y1: m.top, y2: m.top + h, class: 'skewt-guide', visibility: 'hidden' }, svg);
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var i = Math.max(0, Math.min(hours.length - 1, Math.floor(((e.clientX - box.left) * W / box.width - m.left) / step)));
        var p = hours[i];
        guide.setAttribute('x1', x(i));
        guide.setAttribute('x2', x(i));
        guide.setAttribute('visibility', 'visible');
        readout.textContent = [`${p.hour}h`, `${p.temp}°`, p.condition, p.lop ? `${p.lop}% precip.` : null, p.wind].filter(Boolean).join(' · ');
    });
    svg.addEventListener('mouseleave', () => {
        guide.setAttribute('visibility', 'hidden');
        readout.textContent = '';
    });
    container.replaceChildren(svg);
}
