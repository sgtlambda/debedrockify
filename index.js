#!/usr/bin/env node
'use strict';

const path = require('path');

const {trimStart, trimEnd, map, filter, size, intersection} = require('lodash');

const spawn = require('child_process').spawn;

const fs           = require('fs');
const env          = require('node-env-file');
const chalk        = require('chalk');
const Promise      = require('promise');
const globby       = require('globby');
const makeDir      = require('make-dir');
const randomstring = require('randomstring');
const mysql        = require('promise-mysql');

const ncp       = Promise.denodeify(require('ncp').ncp);
const mv        = Promise.denodeify(require('mv'));
const readFile  = Promise.denodeify(require('fs').readFile);
const writeFile = Promise.denodeify(require('fs').writeFile);
const access    = Promise.denodeify(require('fs').access);

class Interruption extends Error {

}

const yargs = require('yargs')
    .option('skip-backup', {
        alias:   'y',
        default: false
    })
    .argv;

const formatPaths = paths => `"${paths.join('", "')}"`;

const expectedPresent = [
    '.env',
    'web/app',
    'web/wp',
    'web/wp/wp-config-sample.php',
];

const expectedAbsent = [
    'web/wp/wp-config.php',
];

const wpFolders = [
    'languages',
    'mu-plugins',
    'plugins',
    'themes',
    'uploads',
    'upgrade'
];

const populateWpConfig = (template, env) => {

    const findReplace = [
        ['database_name_here', env['DB_NAME']],
        ['username_here', env['DB_USER']],
        ['password_here', env['DB_PASSWORD']],
        ['localhost', env['DB_HOST']],

        [`define('WP_DEBUG', false)`, `define('WP_DEBUG', ${(env['WP_ENV'] === 'development' ? 'true' : 'false')})`],

        [/\$table_prefix\s*=\s*'wp_'/, env['DB_PREFIX'] ? `$table_prefix = '${env['DB_PREFIX']}'` : null],
    ];

    for (const [find, replace] of findReplace) {
        if (replace === null) continue;
        template = template.replace(find, replace);
    }

    while (template.indexOf('put your unique phrase here') !== -1) {
        template = template.replace('put your unique phrase here', randomstring.generate(64));
    }

    return template;
};

const mysqldump = ({user, password, database}) => spawn('mysqldump', ['-u', user, '-p' + password, database]);

class Engine {

    constructor(root, opts) {
        this.root = root;
        this.opts = opts;
    }

    /**
     * Get absolute path based on (relative) path
     * @param path
     * @returns {string}
     */
    abs(path) {
        return `${this.root}/${trimStart(path, '/')}`;
    }

    /**
     * Check if the (relative) path exists
     * @param relPath
     * @returns {Promise.<void>}
     */
    exists(relPath) {
        return access(this.abs(relPath)).then(() => true, () => false);
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
    async checkPresence() {

        /**
         * Get presence status for given paths (as an array of [path, present])
         * @param paths
         */
        const checkAllPairs = paths => Promise.all(map(paths, async path => {
            const exists = await this.exists(path);
            return [path, exists];
        }));

        /**
         * Returns an array of all paths that do not match the expected presence status
         * @param paths
         * @param presentExpected
         * @returns {Promise.<*>}
         */
        const filterByStatus = async (paths, presentExpected) => {
            const pairs      = await checkAllPairs(paths);
            const violations = filter(pairs, ([_, present]) => present !== presentExpected);
            return map(violations, ([file]) => file);
        };

        const absent = await filterByStatus(expectedPresent, true);
        if (size(absent)) throw new Interruption(`Expected file(s): ${formatPaths(absent)} not present`);

        const present = await filterByStatus(expectedAbsent, false);
        if (size(present)) throw new Interruption(`Unexpected file(s): ${formatPaths(present)} present`);
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

    /**
     * Move the given wp content type folder from web/app to web/wp/wp-content
     * @param wpFolder
     * @returns {Promise.<boolean>}
     */
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

    /**
     * Run some sanity checks
     * @returns {Promise.<void>}
     */
    async sanityChecks() {
        await this.checkPresence();
        for (const wpFolder of wpFolders)
            await this.checkConflicts(`web/app/${wpFolder}`, `web/wp/wp-content/${wpFolder}`);
    }

    /**
     * Archive the given file/directory into ".debedrockify/old"
     * @param path
     * @returns {Promise.<boolean>}
     */
    async archive(path) {
        if (!await this.exists(path)) return false;
        path = trimStart(path, '/');
        console.info(`Archiving ${path}`);
        await mv(this.abs(path), this.abs(`.debedrockify/old/${path}`));
    }

    readEnv() {
        this.env = env(this.abs('.env'));
    }

    mysqlBackup() {
        console.log('Backing up database...');
        const process = mysqldump({
            user:     this.env['DB_USER'],
            password: this.env['DB_PASSWORD'],
            database: this.env['DB_NAME'],
        });
        const dest    = this.abs(`.debedrockify/mysql_backup_${(new Date()).getTime()}.sql`);
        return new Promise((resolve, reject) => {
            process
                .stdout
                .pipe(fs.createWriteStream(dest))
                .on('finish', function () {
                    resolve();
                })
                .on('error', function (err) {
                    reject(err);
                });
        });
    }

    /**
     * Convert .env to wp-config.php
     * @returns {Promise.<void>}
     */
    async envToWpConfig() {
        console.info('Populating wp-config.php based on .env');
        const template = (await readFile(this.abs('web/wp/wp-config-sample.php'))).toString();
        const wpConfig = populateWpConfig(template, this.env);
        await writeFile(this.abs('web/wp/wp-config.php'), wpConfig);
    }

    async mysqlConnect() {
        this.mysql = await mysql.createConnection({
            host:     this.env['DB_HOST'],
            user:     this.env['DB_USER'],
            password: this.env['DB_PASSWORD'],
            database: this.env['DB_NAME'],
        });
    }

    async mysqlDisconnect() {
        return await this.mysql.end();
    }

    async mysqlQuery(...args) {
        return await this.mysql.query(...args);
    }

    /**
     * Update the values of "siteurl" and "home" in the database
     * @returns {Promise.<void>}
     */
    async updateDbSiteUrl() {
        console.info('Updating "siteurl" and "home" in the database...');
        await this.mysqlQuery("DELETE FROM `wp_options` WHERE `option_name` IN ('siteurl', 'home')");
        const url = this.env['WP_HOME'];
        await this.mysqlQuery("INSERT INTO `wp_options` (`option_name`, `option_value`) VALUES (?, ?)", ['siteurl', url]);
        await this.mysqlQuery("INSERT INTO `wp_options` (`option_name`, `option_value`) VALUES (?, ?)", ['home', url]);
    }

    /**
     * Do all database procedures
     * @returns {Promise.<void>}
     */
    async doDb() {

        await this.mysqlBackup();

        await this.mysqlConnect();
        await this.updateDbSiteUrl();
        await this.mysqlDisconnect();
    }

    /**
     * Full procedure runner
     * @returns {Promise.<void>}
     */
    async run() {
        await this.sanityChecks();
        // if (!this.opts.skipBackup) await this.backup(root);

        await makeDir(this.abs(`.debedrockify/old`));

        // for (const wpFolder of wpFolders)
        //     await this.moveWpContents(wpFolder);

        // await this.archive('web/app');
        // await this.archive('web/cache');
        // await this.archive('web/index.php');
        // await this.archive('web/wp-config.php');

        this.readEnv();

        await this.envToWpConfig();

        await this.doDb();
    }
}

(async () => {

    const root   = trimEnd(process.cwd(), '/');
    const engine = new Engine(root, yargs);

    try {

        await engine.run();

    } catch (e) {

        if (e instanceof Interruption) {
            console.error(chalk.red(e.message));
            process.exit(1);
        } else {
            console.error(e);
            process.exit(127);
        }
    }
})();