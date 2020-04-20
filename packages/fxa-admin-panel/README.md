# Firefox Accounts Admin Panel

This is an internal resource for FxA Admins to access a set of convenience tools.

## Development

- `npm run start|stop|restart` to start, stop, and restart the server as a PM2 process
- `npm run build` to create a production build

**External imports**

You can import React components into this project. This is currently restricted to `fxa-components`:

```javascript
// e.g. assuming the component HelloWorld exists
import HelloWorld from '@fxa-components/HelloWorld';
```

## License

MPL-2.0
