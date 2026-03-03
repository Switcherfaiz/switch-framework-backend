'use strict';

const default401 = `<h1>Login Required</h1><a href="/login">Login</a>`;
const default403 = `<h1>Access Denied</h1><p>Insufficient permissions.</p>`;

function checkRestrict(config) {
  const safeConfig = config && typeof config === 'object' ? config : { rules: [] };
  const rules = Array.isArray(safeConfig.rules) ? safeConfig.rules : [];
  const publicPaths = Array.isArray(safeConfig.public) ? safeConfig.public : null;

  return function restrictMiddleware(req, res, next) {
    try {
      const pathValue = req.path === '/' ? '/dashboard' : req.path;
      const user = req.session && req.session.user ? req.session.user : null;

      // Allow public paths
      if (publicPaths && publicPaths.some(p => pathValue.startsWith(p))) {
        return next();
      }

      // Find matching rule
      for (const rule of rules) {
        if (!rule) continue;

        const matches =
          (rule.path && pathValue === rule.path) ||
          (rule.prefix && (pathValue.startsWith(rule.prefix + '/') || pathValue === rule.prefix));

        if (!matches) continue;

        if (!user) {
          return res.status(401).send(rule.onUnauthenticated || default401);
        }

        const roles = Array.isArray(rule.roles) ? rule.roles : [];
        if (!roles.includes('*') && !roles.includes(user.role)) {
          return res.status(403).send(rule.onForbidden || default403);
        }

        req.authorizedRoute = rule;
        return next();
      }

      next(); // no rule → allow
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { checkRestrict };
