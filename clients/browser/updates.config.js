export default {
  exclude: ['typescript', 'eslint', '@camera.ui/transport', '@camera.ui/logger', 'vue-tsc', '@stylistic/eslint-plugin'],
  cooldown: '7d',
  overrides: [{ include: [/^(@camera\.ui\/|camera\.ui$|node-av$|@seydx\/|camera[-_]ui[-_]|github\.com\/(cameraui|seydx)\/)/], cooldown: 0 }],
};
