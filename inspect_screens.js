const fs = require('fs');
const html = fs.readFileSync('dariai-arcade-game-main/static/index.html', 'utf8');
const screens = html.match(/id="screen-[^"]+"/g) || [];
console.log('Screens found:', screens);
