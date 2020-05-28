const { resolve } = require('path');

const additionalJSImports = {
  'fxa-react': __dirname,
  'fxa-shared': resolve(__dirname, '../fxa-shared'),
};

const customizeWebpackConfig = ({ config, mode }) => {
  // https://storybook.js.org/docs/configurations/typescript-config/#setting-up-typescript-to-work-with-storybook-1
  config.module.rules.push({
    test: /\.(ts|tsx)$/,
    loader: require.resolve('babel-loader'),
    options: {
      presets: [['react-app', { flow: false, typescript: true }]],
    },
  });
  config.resolve.extensions.push('.ts', '.tsx');

  config.module.rules.push({
    test: /\.s[ac]ss$/i,
    use: [
      // Creates `style` nodes from JS strings
      'style-loader',
      // Translates CSS into CommonJS
      'css-loader',
      // Compiles Sass to CSS
      'sass-loader',
    ],
  });
  config.resolve.extensions.push('.scss', '.css');

  let assetLoader;
  const assetRule = config.module.rules.find(({ test }) => test.test('.svg'));
  if (assetRule) {
    assetLoader = {
      loader: assetRule.loader,
      options: assetRule.options || assetRule.query,
    };
  } else {
    assetLoader = {
      loader: resolve(
        __dirname,
        '../../node_modules/@storybook/core/node_modules/file-loader/dist/cjs.js'
      ),
      options: { name: 'static/media/[name].[hash:8].[ext]' },
    };
  }
  config.module.rules.unshift({
    test: /\.svg$/,
    use: ['@svgr/webpack', assetLoader],
  });
  config.module.rules = [{ oneOf: config.module.rules }];

  config.resolve.alias = Object.assign(
    config.resolve.alias,
    additionalJSImports
  );

  return config;
};

module.exports = {
  customizeWebpackConfig,
};
