#!/usr/bin/env node
'use strict';

const path = require('path');

const {trimStart, trimEnd, map, filter, size, intersection} = require('lodash');

const env      = require('node-env-file');
const chalk    = require('chalk');
const Promise  = require('promise');
const globby   = require('globby');
const makeDir  = require('make-dir');
const ncp      = Promise.denodeify(require('ncp').ncp);
const mv       = Promise.denodeify(require('mv'));
const readFile = Promise.denodeify(require('fs').readFile);
const access   = Promise.denodeify(require('fs').access);

class Interruption extends Error {

}

const yargs = require('yargs')
    .option('skip-backup', {
        alias:   'y',
        default: false
    })
    .argv;

const formatPaths = paths => `"${paths.join('", "')}"`;

const expected = [
    '.env',
    'web/app',
    'web/wp',
    'web/wp/wp-config-sample.php',
];

const wpFolders = [
    'languages',
    'mu-plugins',
    'plugins',
    'themes',
    'uploads',
    'upgrade'
];

const wpConfig = (template, env) => {

    template = template.replace('database_name_here', env['DB_NAME']);
    template = template.replace('username_here', env['DB_USER']);
    template = template.replace('password_here', env['DB_PASSWORD']);
    template = template.replace('localhost', env['DB_HOST']);

    return template;
};

class Engine {

    constructor(root, opts) {
        this.root = root;
        this.opts = opts;
    }

    abs(path) {
        return `${this.root}/${trimStart(path, '/')}`;
    }

    /**
     * Check if the (relative) path exists
     * @param relPath
     * @returns {Promise.<void>}
     */
    async exists(relPath) {
        await access(this.abs(relPath)).then(() => true, () => false);
    }

    /**
     * Make a backup in the parent directory to the root
     * @returns {Promise.<void>}
     */
    async backup() {
        const backup = `${this.root}.backup.${(new Date()).getTime()}`;
        console.info(`Creating backup at ${backup}...`);
        await ncp(root, backup);
    }

    /**
     * Check if the given paths exist and throw an Interruption if it doesn't
     * @returns {Promise.<void>}
     */
    async checkPresence(paths = expected) {
        const absent = await Promise.all(map(paths, p => access(this.abs(p)).then(null, () => p)));
        if (size(filter(absent)))
            throw new Interruption(`${formatPaths(filter(absent))} not present`);
    }

    /**
     * Check for files/directories that exist in both given paths and throw an Interruption if there are
     * @param path1
     * @param path2
     * @returns {Promise.<void>}
     */
    async checkConflicts(path1, path2) {
        const in1       = await globby('*', {cwd: this.abs(path1)});
        const in2       = await globby('*', {cwd: this.abs(path2)});
        const intersect = intersection(in1, in2);
        if (size(intersect))
            throw new Interruption(`Conflict: ${formatPaths(intersect)} present in both ${path1} and ${path2}`
                + ', remove one to continue');
    }

    async moveWpContents(wpFolder) {
        const cwd = `web/app/${wpFolder}`;
        if (!await this.exists(cwd)) return false;

        await makeDir(this.abs(`web/wp/wp-content/${wpFolder}`));

        const files = await globby('*', {cwd});
        for (const file of files) {
            const src  = `web/app/${wpFolder}/${file}`;
            const dest = `web/wp/wp-content/${wpFolder}/${file}`;

            console.info(`${chalk.grey('Moving')} ${trimEnd(wpFolder, 's')} ${chalk.bold(file)} ` +
                `${chalk.grey(`(${src}) to ${dest}`)}`);

            await mv(this.abs(src), this.abs(dest));
        }
    }

    async sanityChecks() {
        await this.checkPresence();
        for (const wpFolder of wpFolders)
            await this.checkConflicts(`web/app/${wpFolder}`, `web/wp/wp-content/${wpFolder}`);
    }

    async archive(path) {
        if (!await this.exists(path)) return false;
        path = trimStart(path, '/');
        console.info(`Archiving ${path}`);
        await mv(this.abs(path), this.abs(`.debedrockify/old/${path}`));
    }

    async envToWpConfig() {
        console.info('Translating .env to wp-config.php');
        const template = (await readFile(this.abs('web/wp/wp-config-sample.php'))).toString();
        const envs     = env(this.abs('.env'));
        const conf     = wpConfig(template, envs);
        console.log(conf);
    }

    async run() {
        await this.sanityChecks();
        // if (!this.opts.skipBackup) await this.backup(root);

        // await makeDir(this.abs(`.debedrockify/old`));

        // for (const wpFolder of wpFolders)
        //     await this.moveWpContents(wpFolder);

        // await this.archive('web/app');
        // await this.archive('web/cache');
        // await this.archive('web/index.php');
        // await this.archive('web/wp-config.php');

        await this.envToWpConfig();

    }
}

(async () => {

    const engine = new Engine(trimEnd(process.cwd(), '/'), yargs);

    await engine.run();

})().then(() => null, e => {
    if (e instanceof Interruption) {
        console.error(chalk.red(e.message));
        process.exit(1);
    } else {
        console.error(e.message);
        process.exit(127);
    }
});