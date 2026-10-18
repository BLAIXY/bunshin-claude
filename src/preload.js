const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => async (...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.result;
};

contextBridge.exposeInMainWorld('bunshin', {
  getState: call('state:get'),
  createProfile: call('profile:create'),
  updateProfile: call('profile:update'),
  removeProfile: call('profile:remove'),
  moveProfile: call('profile:move'),
  launch: call('profile:launch'),
  stop: call('profile:stop'),
  launchAll: call('profile:launchAll'),
  openFolder: call('profile:openFolder'),
  arm: call('profile:arm'),
  disarm: call('profile:disarm'),
  routeLink: call('link:route'),
  dismissLink: call('link:dismiss'),
  setLinkHandler: call('linkHandler:set'),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onToast: (fn) => ipcRenderer.on('toast', (_e, msg) => fn(msg)),
});
