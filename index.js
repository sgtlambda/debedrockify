#!/usr/bin/env node
'use strict';

const path = require('path');

const {trimEnd, map, filter, size, intersection} = require('lodash');

const chalk   = require('chalk');
const Promise = require('promise');
const globby  = require('globby');
const makeDir = require('make-dir');
const ncp     = Promise.denodeify(require('ncp').ncp);
const mv      = Promise.denodeify(require('mv'));
const access  = Promise.denodeify(require('fs').access);

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
    'web/wp'
];

const wpFolders = ['themes', 'plugins', 'mu-plugins', 'uploads'];

class Engine {

    constructor(root, opts) {
        this.root = root;
        this.opts = opts;
    }

    async backup() {
        const backup = `${this.root}.backup.${(new Date()).getTime()}`;
        console.info(`Creating backup at ${backup}...`);
        await ncp(root, backup);
    }

    async checkPresence() {
        const absent = await Promise.all(map(expected, p => access(`${this.root}/${p}`).then(null, () => p)));
        if (size(filter(absent)))
            throw new Interruption(`${formatPaths(filter(absent))} not present`);
    }

    async checkConflicts(path1, path2) {
        const join1     = path.join(this.root, path1);
        const join2     = path.join(this.root, path2);
        const in1       = await globby('*', {cwd: join1});
        const in2       = await globby('*', {cwd: join2});
        const intersect = intersection(in1, in2);
        if (size(intersect))
            throw new Interruption(`Conflict: ${formatPaths(intersect)} present in both ${path1} and ${path2}`
                + ', remove one to continue');
    }

    async moveWpContents(wpFolder) {

        const cwd = `web/app/${wpFolder}`;

        await makeDir(`${this.root}/web/wp/wp-content/${wpFolder}`);

        const files = await globby('*', {cwd});
        for (const file of files) {
            const src  = `web/app/${wpFolder}/${file}`;
            const dest = `web/wp/wp-content/${wpFolder}/${file}`;

            console.info(`${chalk.grey('Moving')} ${trimEnd(wpFolder, 's')} ${chalk.bold(file)} ` +
                `${chalk.grey(`(${src}) to ${dest}`)}`);

            await mv(`${this.root}/${src}`, `${this.root}/${dest}`);
        }
        // const contents = await
    }

    async sanityChecks() {
        await this.checkPresence();
        for (const wpFolder of wpFolders)
            await this.checkConflicts(`web/app/${wpFolder}`, `web/wp/wp-content/${wpFolder}`);
    }

    async run() {
        await this.sanityChecks();
        if (!this.opts.skipBackup) await this.backup(root);
        for (const wpFolder of wpFolders)
            await this.moveWpContents(wpFolder);
        
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