import {Caveman, type CavemanOptions, type DriveHandle} from '../src/index.js';
import {AppBridge} from '../src/app-bridge.js';

const opts: CavemanOptions = {
  apiKey: 'cave_live_test',
  baseURL: 'https://gateway.caveman.so',
  controlURL: 'https://api.caveman.so',
};

const cv = new Caveman(opts);
const drive: DriveHandle = cv.drives.drive('knowledge');
const bridge = new AppBridge('app_1', {controlURL: 'https://api.caveman.so', apiKey: 'capp_test'});

void drive;
void bridge;
void cv.inference;
void cv.agents;
void cv.sessions;
void cv.sandboxes;
void cv.connectors;
void cv.secrets;
void cv.rooms;
void cv.apps;
void cv.evals;
void cv.approvals;
void cv.credits;
