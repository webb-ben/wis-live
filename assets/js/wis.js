String.prototype.rsplit = function (sep, maxsplit) {
    var split = this.split(sep);
    return maxsplit ? [split.slice(0, -maxsplit).join(sep)].concat(split.slice(-maxsplit)) : split;
};

String.prototype.hexDecode = function(){
    var j;
    var hexes = this.match(/.{1,4}/g) || [];
    var back = "";
    for(j = 0; j<hexes.length; j++) {
        back += String.fromCharCode(parseInt(hexes[j], 16));
    }

    return back;
}

L.Control.Info = L.Control.extend({
    onAdd: function(map) {
        var container = L.DomUtil.create('div', 'leaflet-control');
        container.style.margin = '8px'

        var icon = L.DomUtil.create('span', 'dot', container);
        icon.innerHTML = '<i style="font-size: 18px;">i</i>';
    
        var msg = L.DomUtil.create('span', 'popup', container);
        msg.innerHTML = '<div style="margin: 4px;">WIS 2.0 Live shows real-time weather observations as they are published through the WMO Information System. This page is not affiliated with WMO.</div>'
        msg.style.display = 'none';

        L.DomEvent.on(icon, 'mouseover', function(){
            msg.style.display = 'inline-block';
            icon.style.display = 'none';
        });

        L.DomEvent.on(msg, 'mouseout', function(){
            msg.style.display = 'none';
            icon.style.display = 'inline-block';
        });

        return container;
    },

    onRemove: function(map) {
        // Nothing to do here
    }
});

L.control.info = function(opts) {
    return new L.Control.Info(opts);
}

const host = 'wss://globalbroker.meteo.fr:443/mqtt';
const options = {
    username: 'everyone',
    password: '00650076006500720079006f006e0065'.hexDecode(),
    keepalive: 60,
    protocolVersion: 5,
    reconnectPeriod: 1000,
    connectTimeout: 30 * 1000,
};

console.log('Connecting mqtt client');
const client = mqtt.connect(host, options);

client.on('connect', function () {
    client.subscribe(['origin/#', 'cache/#'], function (err) {
        if (!err) {
            console.log('Connected!')
        }
    })
})

client.on('error', (err) => {
    console.log('Connection error: ', err)
    client.end()
});

client.on('reconnect', () => {
    console.log('Reconnecting...')
});

const markers = new Array();
const regex = /(?!WIGOS_)(\d-\d+-\d-[\da-zA-Z]+)/g;
client.on('message', function (topic, message) {
    // message is Buffer
    const feature = JSON.parse(message.toString())
    if (!feature.geometry || !feature.geometry.hasOwnProperty('type')){
        console.debug(`Message from ${topic} missing geometry`);
        return;
    }
    
    const props = feature.properties;
    var [origin, t] = topic.split('/wis2/')
    var [country] = t.split('/', 1)
    var popup = `<tr>
                    <th>Channel</th>
                    <td>${origin}</td>
                </tr><tr>
                    <th>Country</th>
                    <td>${country}</td>
                </tr><tr>
                    <th>Publish Time</th>
                    <td>${props.pubtime}</td>
                </tr>`

    if (t.includes('webcam')){
        var color = topic.startsWith('cache') ? '#F8A700' : '#D5E3F0';
        var marker = renderMarker(feature, color);
        for (const link of feature.links){
            const url = new URL(link.href);
            const filename = url.pathname.rsplit('/', 1).pop();
            if (link.rel == 'canonical'){
                popup += `<tr>
                            <td colspan="2">
                            <a target="_blank" href="${link.href}"" type="${link.type}" title="${filename}" rel="${link.rel}"><img src="${link.href}" width="500"></img></a>
                            </td>
                          </tr>`
            }
        }
        marker.bindPopup(`<table class="table table-striped"> ${popup} </table>`, { maxWidth: 500 });
        marker.bindTooltip(props.metadata_id).openTooltip();
        setTimeout(closeTooltip, 1500, marker);

    } else if (t.includes('synop') || t.includes('weather')) {
        if (!props.wigos_station_identifier && !props.data_id.match(regex)){
            console.log(`Invalid wigos station identifier from ${topic}`);
            return;
        }

        var wsi = props.wigos_station_identifier || props.data_id.match(regex).pop();
        var color = topic.startsWith('cache') ? "#6cc644" : "#D5E3F0";
        var marker = renderMarker(feature, color);

        popup += `<tr>
                    <th>Station Identifier</th>
                    <td>${wsi}</td>
                  </tr>`
        if (origin.startsWith('cache')){
            marker.bindTooltip(wsi).openTooltip();
            setTimeout(closeTooltip, 1500, marker);
            popup += `<tbody>`
            for (const link of feature.links){
                const url = new URL(link.href);
                const filename = url.pathname.rsplit('/', 1).pop();
                if (link.rel == 'canonical'){
                    popup += `<tr>
                                <th>Data Download</th>
                                <td><a target="_blank" href="${link.href}"" type="${link.type}" title="${filename}" rel="${link.rel}">${filename}</a></td>
                              </tr>`
                } else if (link.rel == 'via'){
                    popup += `<tr>
                                <th>${link.rel}</th>
                                <td><a target="_blank" href="${link.href}" type="${link.type}" rel="${link.rel}">${url.hostname}</a></td>
                              </tr>`
                } else {
                    popup += `<tr>
                                <th>${link.rel}</th>
                                <td><a target="_blank" href="${link.href}"" type="${link.type}" rel="${link.rel}">${link.href}</a></td>
                              </tr>`
                }
            }
            popup += `</tbody>`
        }

        marker.bindPopup(`<table class="table table-striped"> ${popup} </table>`, { maxWidth: 500 });

    } else if (feature.geometry.type === 'Polygon' && props.conformsTo) {
        var poly = L.geoJSON(feature);
        var bounds = poly.getBounds();
        if (feature.id || (bounds._northEast.lat >= 90 && bounds._southWest.lat <= -90)){
            console.log(`Invalid bounds from ${topic}`);
            return;
        } else {
            poly.addTo(map);
        }

        var popup = `<tr>
                        <th>Identifier</th><td>${feature.id}</td>
                     </tr><tr>
                        <th>Topic</th><td>${props["wmo:topicHierarchy"]}</td>
                     </tr><tr>
                        <th>Description</th><td>${fprops.description}</td>
                     </tr>`

        for (const link of feature.links){
            if (link.type != 'MQTT' && link.title){
                popup += `<tr>
                    <th>${link.type}</th>
                    <td><a target="_blank" href="${link.href}"" type="${link.type}" rel="${link.rel}">${link.title}</a></td>
                  </tr>`
            }
        }
        poly.bindPopup(`<table class="table table-striped"> ${popup} </table>`,{ maxWidth: 500 });
        poly.bringToBack();
        setTimeout(removeMarker, 590000, poly);
    }
})

function renderMarker(feature, color){
    return L.geoJSON(feature, {
        pointToLayer: function (geoJsonPoint, latlng) {
            var m = L.circleMarker(latlng, {
                color: shadeColor(color, -25),
                fillColor: color,
                radius: estimateRadius(),
                weight: 1,
                opacity: 1,
                fillOpacity: 1,
            });
            setTimeout(recolorMarker, 60000, m);
            markers.push(m);
            return m;
        }
    }).addTo(map);
}

function reRender() {
    var z = map.getZoom();
    if (z <= 17){
        for (const m of markers){
            m.setRadius(estimateRadius());
            m.redraw();
        }
    }

}

function estimateRadius(){
    var z = map.getZoom();
    return 1.5 * (z - 1.5);
}

function removeMarker(feature) {
    feature.removeFrom(map);
}

function closeTooltip(feature){
    feature.closeTooltip();
}

function recolorMarker(m){
    m.setStyle({
        opacity: m.options.opacity - 0.01667,
        fillOpacity: m.options.fillOpacity - 0.01667,
        color: shadeColor(m.options.color, -2.5),
        fillColor: shadeColor(m.options.fillColor, -2.5)
    });
    m.redraw();
    if (m.options.opacity >= 0.1){
        setTimeout(recolorMarker, 180000, m);
    } else {
        const index = markers.indexOf(m);
        if (index > -1) {
            m.removeFrom(map);
            markers.splice(index, 1);
        }
    }
}

function shadeColor(color, percent) {

    var R = parseInt(color.substring(1,3),16);
    var G = parseInt(color.substring(3,5),16);
    var B = parseInt(color.substring(5,7),16);

    R = parseInt(R * (100 + percent) / 100);
    G = parseInt(G * (100 + percent) / 100);
    B = parseInt(B * (100 + percent) / 100);

    R = (R<255)?R:255;  
    G = (G<255)?G:255;  
    B = (B<255)?B:255;  

    R = Math.round(R)
    G = Math.round(G)
    B = Math.round(B)

    var RR = ((R.toString(16).length==1)?"0"+R.toString(16):R.toString(16));
    var GG = ((G.toString(16).length==1)?"0"+G.toString(16):G.toString(16));
    var BB = ((B.toString(16).length==1)?"0"+B.toString(16):B.toString(16));

    return "#"+RR+GG+BB;
}
