// Part of ICU tools
// Copyright (C) 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

// With ES6
const JiraApi = require('jira-client');
const sqlite = require('sqlite');
const isFilePromise = require('is-file-promise');
const config = require('./config.json');
const fs = require('fs');
const obfuscate = require('./lib/obfuscateEmail');
const mkdirp = require('mkdirp-then');
const chalk = require('chalk');

config.reporterMap = require('./reporterMap.json'); // ask sffc for this


const InterMap = require('./lib/intermap');

// Initialize
const jira = new JiraApi(require('./local-auth.json').jira);
/*
1-liner:
const jira = new (require('jira-client')) (require('./config.json').jira);
*/

// Fetch users that we don't have the name for
async function getUserByAccountId(accountId) {
    return jira.doRequest(jira.makeRequestHeader(jira.makeUri({
          pathname: "/user?accountId=".concat(accountId)
        })));
}

async function deleteAttachment(attachmentId) {
    // DELETE /rest/api/2/attachment/{id}
    return jira.doRequest(jira.makeRequestHeader(jira.makeUri({
        pathname: "/attachment/".concat(attachmentId),
      }),
      {
        followAllRedirects: true,
        method: 'DELETE'
      }));
}

// Promise for main Trac DB
const dbPromise = sqlite.open(config.db.path, { cached: true });
// const Old2New = require('./lib/old2new');

const ticketwhere = process.argv[2] || '';

console.log('ticket filter:', ticketwhere);
// return;

// const o2n = geto2n(config.old2new.path);

// @@@ NOTE: this controls which tickets are imported. 
const allTickets = dbPromise.then(async (db) => db.all(`select * from ticket ${ticketwhere}`));

/**
 * This always returns something valid. can be an accountid
 * @param {String} tracReporter - trac id
 */
async function getReporter(tracReporter) {
    if(!tracReporter) return null;
    // Trac reporter
    let reporterEntry = config.reporterMap[tracReporter] || config.reporterMap.nobody;
    if(!reporterEntry.name && !reporterEntry.accountId) {
        throw Error('No name or key for ' + tracReporter + ' - ' + JSON.stringify(reporterEntry));
    }
    return reporterEntry;
}

/**
 * @param {String} tracReporter - trac id
 */
async function getReporterWithName(tracReporter) {
    if(!tracReporter) return null;
    let reporterEntry = config.reporterMap[tracReporter];
    if(!reporterEntry) return null;

    if(!reporterEntry.name && reporterEntry.accountId) {
        // Go fish.
        const reporterValue = await getUserByAccountId(reporterEntry.accountId);
        // console.dir(reporterValue);
        // throw Error('Foo');
        reporterEntry.name = reporterValue.name;
        reporterEntry.key = reporterEntry.key;
        reporterEntry.displayName = reporterEntry.displayName;

        // console.log('Resolved', reporterValue.name, 'from', reporterEntry.accountId);
    }
    return reporterEntry;
}

/*
 * ticket|time|author|field|oldvalue|newvalue
 * 13828|1528927025850017|shane|comment|3|LGTM
 */
const allCommentsByTicket = dbPromise.then(async (db) => db.all(`select * from ticket_change where field='comment' and newvalue <> '' order by time`))
.then((all) => all.reduce((p,v) => {
    const o = p[v.ticket] = p[v.ticket] || [];
    o.push(v);
    return p;
}, {}));

const attachmentsByTicket = dbPromise.then(async (db) => db.all(`select * from attachment where type='ticket' order by id`))
.then((all) => all.reduce((p,v) => {
    const o = p[v.id] = p[v.id] || [];
    o.push(v);
    return p;
}, {}));

const maxTicket = dbPromise.then(async (db) => (await db.get('select id from ticket order by id DESC limit 1')).id);

const allComponents = dbPromise.then(async (db) => db.all('select * from component'));

const allPriorities = dbPromise.then(async (db) => db.all('select distinct priority from ticket'))
.then(l => l.map(v=>v.priority).filter(v => (v && v!=='(null)')));

// promise to array of milestones
const allMilestones = dbPromise.then(async db => db.all('select distinct milestone from ticket'))
.then(l => l.map(v=>v.milestone).filter(v => (v && v.trim() && v !== 'UNSCH')));

const rev2ticket = dbPromise.then(async (db) => db.all('select * from rev2ticket'))
.then((all) => all.reduce((p,v) => {
    p[v.rev] = v.ticket;
    return p;
}, {}));

const ticketCount = dbPromise.then(async (db) => db.get('select count(*) as count from ticket'));

const project = jira.getProject(config.project.name);
const issueTypes = jira.listIssueTypes();
const components = jira.listComponents(config.project.name);
const priorities = jira.listPriorities(config.project.name);
const versions = jira.getVersions(config.project.name);
const statuses = jira.listStatus/*…es*/(); // https://english.stackexchange.com/a/43324
const nameToIssueType = issueTypes.then(async (issueTypes) => issueTypes.reduce((p,v) => {
    p[v.name] = v;
    return p;
}, {}));

const allFields = jira.listFields();


const nameToFieldId = allFields.then(async (allFields) => allFields.reduce((p,v) => {
    p[v.name] = v;
    return p;
}, {}));

async function fieldIdToName(f) {
    const n2f = await nameToFieldId;
    for([k,v] of Object.entries(n2f)) {
        if(v && (v.id === f)) return k;
    }
    return f;
}

const _nameToComponent = components.then(async (allFields) => allFields.reduce((p,v) => {
    p[v.name] = v;
    return p;
}, {}));

const _nameToPriority = priorities.then(async (allFields) => allFields.reduce((p,v) => {
    p[v.name] = v;
    return p;
}, {}));

const _nameToVersion = versions.then(async (allFields) => allFields.reduce((p,v) => {
    p[v.name] = v;
    return p;
}, {}));

// copy and paste much?
const _nameToStatus = statuses.then(async (allFields) => allFields.reduce((p,v) => {
    p[v.name] = v;
    return p;
}, {}));

async function nameToComponentId(name) {
    const n2c = await _nameToComponent;
    const info = n2c[name];
    if(!info) return null;
    const {id} = info;
    if(id) return id;
}

async function nameToVersionId(name) {
    const n2c = await _nameToVersion;
    const info = n2c[name];
    if(!info) return null;
    const {id} = info;
    if(id) return id;
}

async function nameToPriorityId(name) {
    const n2c = await _nameToPriority;
    const info = n2c[name];
    if(!info) return null;
    const {id} = info;
    if(id) return id;
}
async function nameToStatusId(name) {
    const n2c = await _nameToStatus;
    const info = n2c[name];
    if(!info) return null;
    const {id} = info;
    if(id) return id;
}

/**
 * Start up the 'old2new' machinery. Read existing DB if it exists.
 * @param {String} path 
 */
// async function geto2n(path) {
//     const o2n = new Old2New();
//     try {
//         const isDir =  isFilePromise(path).catch(()=>false);
//         if(await isDir) {
//             await o2n.read(path);
//         } else {
//             console.log('No o2n at ',path,', setting up new');
//         }
//     } catch(e) {
//         console.error('skipping o2n read of', path, 'because', e);
//     }
//     return o2n;
// }

/**
 * Return the custom fields for a ticket.
 * THis is a function and a new query to save typing.
 * @param {*} ticket 
 */
async function custom(ticket) {
    const list =  await (await dbPromise).all(`select * from ticket_custom where ticket = ${ticket}`);
    return list.reduce((p,v) => {
        p[v.name]=v.value;
        return p;
    }, {});
}

/**
 * get the latest version of a wiki page
 * @param {String} name 
 */
async function getWiki(name) {
    return (await dbPromise).get(`select * from wiki where name='${name}' order by version desc limit 1;`);
}

const InterMapTxt = getWiki('InterMapTxt')
.then((m) => m.text)
.then((l) => new InterMap(l));

/* async */ function forTracType(type) {
    if(!config.mapTypes) {
        // We don't care. Not using types.
        return forJiraIssueType(type, 'Bug');
    }

    const jiraType = config.mapTypes[type];
    if(!jiraType) throw Error(`Unknown trac ticket type ${type} (check mapTypes)`);
    return forJiraIssueType(type, jiraType);
}

async function forJiraIssueType(type, jiraType) {   
    const map = await nameToIssueType;
    const jiraIssueType = map[jiraType];
    if(!jiraIssueType) throw Error(`Unknown Jira type ${jiraType} (for ${type} - check mapTypes and JIRA`);
    // console.log(type, jiraType, jiraIssueType);
    return jiraIssueType;
    // (await nameToIssueType)[config.mapTypes[ticket.type]]}    
}

async function getFieldIdFromMap(mapId) {
    const customName = config.mapFields[mapId];
    if (!customName) throw Error(`no customName for ${mapId}`);
    const subMap = await nameToFieldId;
    if(!subMap[customName]) throw Error(`Need to create custom field ${customName}`);
    const {key, id} = subMap[customName];
    // console.log(subMap[customName].id)
    if (!key && !id ) throw Error(`No key or id for ${customName} (${mapId}) - have ${Object.keys(subMap[customName])}`);
    // console.log(mapId,customName,customId);
    return key || id;
}

const updTix = {};
const errTix = {};
let scanno = 0;

async function doit() {

    const projectId = (await project).id;
    const {count} = await ticketCount;
    console.log(` tickets to process`);

    console.log(`trac: count ${count}, max ${await maxTicket}`);
    // console.dir(await project);
    // return;
    // console.dir(await nameToIssueType);
    // console.dir(await nameToFieldId);
    // console.log(await InterMapTxt);
    // console.log(await components);
    // console.dir(await _nameToComponent);
// return;
    let addedComps = 0;
    for(component of (await allComponents)) {
        const {name,description} = component;
        const existingId = await nameToComponentId(name);
        if(!existingId) {
            const body = {
                name,
                description,
                project: config.project.name,
                projectId
            };
            console.log('adding component',name);
            // hack: add it back to the cache
            await jira.addNewComponent(body);
            addedComps++
        }
    }
    for(name of (await allPriorities)) {
        // const {name,description} = priority;
        const existingId = await nameToPriorityId(name);
        if(!existingId) {
            const body = {
                name,
                // description,
                project: config.project.name,
                projectId
            };
            console.log('need to add priority MANUALLY',name);
            // hack: add it back to the cache
            // Ooops - can't do this from the API
            // await jira.addNewPriority(body);
            addedComps++
        }
    }
    for(name of (await allMilestones)) {
        // const {name,description} = priority;
        const existingId = await nameToVersionId(name);
        if(!existingId) {
            // let's see if we can get some metadata
            const milestoneMeta = (await dbPromise.then(async db => db.get(`select * from milestone where name='${name}'`))) || {
                // fallback metadata
                name,
                due: 0,
                completed: 0,
                description: `Milestone ${name} missing in trac`
            };
            const body = {
                name,
                description: (await InterMapTxt).render({text: milestoneMeta.description
                    .replace(/(#|ticket:|cldrbug:)([0-9]+)/ig, `[${config.project.name}-$2]`) // more aggressive ticket linking
                    // .replace(/(#|ticket:|icubug:)([0-9]+)/ig, `[${config.project.name}-$2]`) // more aggressive ticket linking
                , ticket: {}, config, project, rev2ticket: await rev2ticket}),
                project: config.project.name,
                projectId,
                released: (milestoneMeta.completed != 0),
                releaseDate: new Date(milestoneMeta.completed / 1000).toISOString(),
                releaseDateSet: (milestoneMeta.completed != 0),
                overdue: (milestoneMeta.completed != 0)&&(new Date(milestoneMeta.due/1000).getTime() <= new Date().getTime())
            };
            // console.dir(body);
            console.log('needed to add version',name);
            await jira.createVersion(body);
            addedComps++
        }
    }
    if(addedComps) {
        throw Error(`^ Just added or need to add ${addedComps} components/priorities/versions ,please try again`);
    }
    
    const all = await allTickets;
    // const custom = await ticketCustom;

    console.log('Skipping ticket creation. Going right to ticket update');
    console.log('Getting tickets created..');
    // STEP 1 - get all summaries in 
    for(ticket of all) {
        // console.log('Considering', ticket);
        const {id, summary, description} = ticket;
        process.stdout.write(`${id}: ${chalk.dim.green(summary.substr(0, 40))} `);
        // console.log(id, summary);
        // return;
        // make custom fields look like real fields
        Object.assign(ticket, await custom(id));
        const {component, owner, private,sensitive, reporter} = ticket;
        const hide = (/*private==='y' ||*/ sensitive == 1);
        scanno++;
        // const jiraId = (await o2n).getJiraId(id);
        const issueKey =  `${config.project.name}-${id}`;
        const jiraIssue = await jira.findIssue(
            issueKey,
            null, '', //expand,
            null, //fields,
            'description', //properties,
            //fieldsByKeys
        ).catch((e) => {
            console.error(e);
            process.exitCode=1;
            console.error(`Could not load issue ${issueKey} — ${e}. `);
            errTix[id] = `Could not load issue ${issueKey} — ${e}. `;
            return null;
        });
        if(!jiraIssue) continue; // could not load
        // console.dir(ticket, {color: true, depth: Infinity});
        // console.dir(jiraIssue, {color: true, depth: Infinity});
        jiraId = jiraIssue.id;
        // unpack fields
        const fields = {};

        // Set any fields that are wrong.
        {
            // Warning: component = trac component, components = jira component.   Yeah.
            const {fixVersions, issuelinks, labels, priority, security, components,
                description, issuetype, summary, reporter, assignee} = jiraIssue.fields;

            // Issue Type.
            jiraIssueType = (await forTracType(ticket.type));
            // console.log(issuetype.id, jiraIssueType.id);
            if (issuetype.id !== jiraIssueType.id) {
                fields.issuetype = {id: jiraIssueType.id};
            }

            // Summary.
            if(summary !== (ticket.summary || '(no summary)')) {
                fields.summary = (ticket.summary || '(no summary)');
            }

            let preDescriptionJunk = '';
            // XREF is links. Not a field.
            if(ticket.xref && ticket.xref.trim()) {
                linkedIds = (issuelinks||[])
                .filter(link => link.type.id === config.xrefLinkType.id)
                .map(link => (link.outwardIssue || link.inwardIssue).key);
                const linkedIdSet = new Set(linkedIds);
                for(let xref of ticket.xref.trim().split(/[, ]+/)) {
                    xref =  xref.replace(/^ticket:[ ]*/,'')
                    .replace(/^#[ ]*/,'')
                    .replace(/^[p][ ]*/,'')
                    .trim();
                    if(/(cldrbug|eclipsebug):[0-9]+/.test(xref)) {
                        // argh.. 
                        preDescriptionJunk = preDescriptionJunk + 'h6. Also see: ' + xref + '\n\n';
                        continue;
                    }
                    xref = xref.replace(/[^0-9]*/g, '');
                    if(!xref) continue;
                    if(!/[0-9]+/.test(xref)) {
                        preDescriptionJunk = preDescriptionJunk + 'h6. Malformed Xref: ' + xref + '\n\n';
                        continue;
                    }
                    // console.log('XREF', xref);
                    const targetLink = `${config.project.name}-${xref}`;
                    if(!linkedIdSet.has(targetLink) && (targetLink !== issueKey)) {
                        // console.log('Need', targetLink);
                        const link = await jira.issueLink({
                            type: config.xrefLinkType,
                            inwardIssue: {
                                key: issueKey
                            },
                            outwardIssue: {
                                key: targetLink
                            }
                        })
                        .catch((e) => {
                            // errTix[`${issueKey}::${targetLink}`] = e.toString();
                            preDescriptionJunk = preDescriptionJunk + 'h6. Orphan Xref: ' + xref + '\n\n';
                            console.error(`\n${chalk.red('Could not XREF ')} ${issueKey} // ${targetLink} : ${e.message}`);
                        });
                    }
                }
            } else {
                if(issuelinks && issuelinks.length) {
                    // console.log('Huh, ', `xref unset but ${issuelinks.length} links in JIRA- Probably incoming xrefs.`);
                }
            }

            // Component is an array
            const componentId = await nameToComponentId(component);
            if(componentId) {
                if((components[0] || {}).id !== componentId) {
                    fields.components = [{id: componentId }];
                }
            } else {
                if(component) {
                    // errTix[`component-${component}`] = 'not in jira';
                    preDescriptionJunk = preDescriptionJunk + 'h6. Deleted Component: ' + component + '\n\n';
                }
                if((components[0] || {}).id) {
                    fields.components = null; // set to no component.
                }
            }

            // So is version an array
            const versionId = await nameToVersionId(ticket.milestone);
            if(versionId) {
                if((fixVersions[0] || {}).id !== versionId 
                    || (fixVersions.length !== 1)) { // << will delete excess versions
                    fields.fixVersions = [{id: versionId }];
                }
            } else {
                // If it's not here, we assume it was rejected by the filter (UNSCH, etc)
                // so remove.
                // if(ticket.milestone) {
                //     // errTix[`component-${component}`] = 'not in jira';
                //     preDescriptionJunk = preDescriptionJunk + 'h6. Deleted Component: ' + component + '\n\n';
                // }
                if((fixVersions[0] || {}).id) {
                    fields.fixVersions = null; // set to no version.
                }
            }

            
            // Description - rendered
            const newDescription = (await InterMapTxt).render({text: (preDescriptionJunk + ticket.description), ticket, config, project, rev2ticket: await rev2ticket});

            // If description is over the limit, truncate and move to a file
            if(newDescription.length > 32000) {
                await mkdirp(`${config.db.attachmentPath}/${id}/`);
                fs.writeFileSync(`${config.db.attachmentPath}/${id}/${issueKey}.txt`, newDescription, 'utf-8');
                const abt = (await attachmentsByTicket);
                abt[id] = abt[id] || [];
                abt[id].push({
                    filename: `${issueKey}.txt`
                });
                const miniDescription = `h1. Text was too large\n\nLimit is about (${newDescription.length}, >32k)\nSee attached ${issueKey}.txt for original text.\n`;
                if(description !== miniDescription) {
                    fields.description = miniDescription;
                }
                ticket.keywords = (ticket.keywords||'')+' jira-overlong-description';
            } else {
                if(description !== newDescription) {
                    fields.description = newDescription;
                }
            }

            // PUNT…  move status/resolution to custom fields
            {
                let wantStatus = (ticket.status || '').trim();
                let wantResolution = (ticket.resolution || '').trim();
                setIfNotSet(await getFieldIdFromMap('status'), wantStatus);
                setIfNotSet(await getFieldIdFromMap('resolution'), wantResolution);
    
                // ticket.keywords = (ticket.keywords||'')+` status-${wantStatus} resolution-${wantResolution}`;

            }
            if(config.mapFields.project) {
                setIfNotSet(await getFieldIdFromMap('project'), ticket.project);
            }
            if(config.mapFields.weeks) {
                setIfNotSet(await getFieldIdFromMap('weeks'), Number(ticket.weeks));
            }
            if(config.mapFields.cc) {
                setIfNotSet(await getFieldIdFromMap('cc'), (ticket.cc||'').split(/[, ]+/).map(e => obfuscate(e)).sort().join(','));
            }
            // TODO: watchers.

            if(config.mapFields.xpath) {
                const value = (ticket.xpath || '').replace(/[ ]+/g, '\n').trim();
                if(value) {
                //    setIfNotSet(await getFieldIdFromMap('xpath'), 
                //        {value});
                    setIfNotSet(await getFieldIdFromMap('xpath'), 
                        value);
                } else {
                    setIfNotSet(await getFieldIdFromMap('xpath'), 
                        null);
                }
            }
            if(config.mapFields.locale) {
                const value = (ticket.locale || '').replace(/[, ]+/g, '\n').trim();
                setIfNotSet(await getFieldIdFromMap('locale'), value);
            }
            if(config.mapFields.phase) {
                if(ticket.phase) {
                    setIfNotSet(await getFieldIdFromMap('phase'), {value: ticket.phase});
                } else {
                    setIfNotSet(await getFieldIdFromMap('phase'), ticket.phase);
                }
            }

            // Reporter
            setIfNotSet('reporter', await getReporter(ticket.reporter));
            setIfNotSet('assignee', await getReporter(ticket.owner));

            // Reporter
            // Trac reporter

            function setIfNotSet(k,v) {
                if(v == '' || !v) v = null; // prevent noise.
                // console.dir({j: jiraIssue.fields[k], v});
                if(v && (v.accountId || v.name)) {
                    // its a user.
                    if(!jiraIssue.fields[k] ||
                        jiraIssue.fields[k].accountId !== v.accountId) {
                            fields[k] = v;
                        } else {
                            // not a partial match.
                        }
                } else if(v && v.value) {
                    if(!jiraIssue.fields[k] ||
                        jiraIssue.fields[k].value !== v.value) {
                            fields[k] = v;
                        } else {
                            // not a matched field
                        }
                } else if(jiraIssue.fields[k] !== v) {
                    // console.dir({j: jiraIssue.fields[k], v});
                    fields[k] = v;
                }
            }

            // setIfNotSet(await getFieldIdFromMap('id'), id.toString());
            if(config.mapFields.reporter) {
                setIfNotSet(await getFieldIdFromMap('reporter'), obfuscate(ticket.reporter));
            }
            if(config.mapFields.owner) {
                setIfNotSet(await getFieldIdFromMap('owner'), ticket.owner);
            }
            if(config.mapFields.revw) {
                // console.log('review field', await getFieldIdFromMap('revw'), ticket.revw);
                setIfNotSet(await getFieldIdFromMap('revw'), await getReporter(ticket.revw));
            }
            if(config.mapFields.time) {
                const timeField = await getFieldIdFromMap('time');
                const jiraTime = new Date(jiraIssue.fields[timeField] || 0);
                const tracTime = new Date(ticket.time/1000);
                if(jiraTime.toDateString() !== tracTime.toDateString()) {
                    // only if off by a day!
                    setIfNotSet(await getFieldIdFromMap('time'), new Date(ticket.time/1000).toISOString());
                }
            }

            const priorityId = await nameToPriorityId(ticket.priority||'assess')|| await nameToPriorityId('assess');
            if(priorityId) {
                if((priority||{}).id !== priorityId) {
                    fields.priority = {id: priorityId };
                }
            } else {
                if((priority||{}).id) {
                    fields.priority = null; // set to no priority?
                }
            }

            // Security needs to be set if different (may be null)
            if(hide) {
                if(security === null) {
                    fields.security = { id: config.security.sensitive }; // set security
                }
            } else {
                if(security != null) {
                    fields.security = null; // unset security
                }
            }

            // labels/keywords
            if(ticket.keywords) {
                const tracKw = Array.from(new Set(ticket.keywords.trim().split(/[, ]+/).filter(k => k))).sort();
                const jiraKw = Array.from(new Set(labels||[])).sort();
                // console.log(tracKw,jiraKw);
                // ok, ok
                if(tracKw.join(' ') !== jiraKw.join(' ')) {
                    fields.labels = tracKw;
                }
            } else {
                if(labels && labels.length) fields.labels = null;
            }


        }

        // If there's any change, write it.
        if(Object.keys(fields).length > 0) {
            if(false) console.dir({id, issueKey, jiraId, fields}, {color: true, depth: Infinity});

            const changedSet = Object.keys(fields).map(f => fieldIdToName(f));
            process.stdout.write(`\r${chalk.yellow(id)}: ≈ ${chalk.green(summary.substr(0,10))} ≈ ${chalk.blue((await Promise.all(changedSet)).join(','))}                       \r`);

            const ret = await jira.updateIssue(issueKey, {fields, notifyUsers: false})
            .catch((e) => {
                errTix[issueKey] = e.errors || e.message || e.toString();
                // console.error(e);
                return {error: e.errorss || e.message || e.toString()};
            });
            if(errTix[issueKey]) {
                process.stdout.write(`${chalk.red.bold(id)}!\n`);
            } else {
                process.stdout.write(`${chalk.green.bold(id)}!\n`);
            }
            updTix[issueKey] =  ret;
            // console.dir(ret);
        } else {
            process.stdout.write(`\r${id} ${chalk.dim("No Change =======================")}                       \r`);
            // console.log(' ', 'No change:', id, issueKey, jiraId);
        }

        // const wantStatus = (ticket.status || 'new');
        // const wantStatusId = await nameToStatusId(wantStatus);
        // if(jiraIssue.fields.status.id !== wantStatusId) {
        //     // console.error(`in state ${jiraIssue.fields.status.name} want ${wantStatus} (${wantStatusId})`);
        //     const transitions = await jira.listTransitions(issueKey);
        //     // how to get there?
        //     const goodTransitions = transitions.transitions.filter(t => t.to.id == wantStatusId);
        //     // console.dir(goodTransitions, {depth: Infinity});
        //     if(goodTransitions.length != 1) {
        //         throw Error(`Too many or zero paths from ${issueKey} to ${wantStatus} : ${JSON.stringify(goodTransitions)}`);
        //     }
        //     body = {
        //         //update: {
        //             // comment: {
        //                 // no comments from the peanut gallery
        //             // }
        //         // },
        //         transition: { id: goodTransitions[0].id },
        //         // fields: {
        //         //     resolution: {
        //         //         name: ticket.resolution
        //         //     }
        //         // }
        //     };

        //     const doTransition = await jira.transitionIssue(issueKey, body).catch((e) => {
        //         errTix[`${issueKey}::${wantStatus}`] = e.toString();
        //         console.error(e.toString);
        //         return false;
        //     });
        //     if(!doTransition) {
        //         console.dir(doTransition);
        //     }
        // }

        // TODO: create pseudo attachments for long comments
        // * ticket|time|author|field|oldvalue|newvalue
        // * 13828|1528927025850017|shane|comment|3|LGTM
        // COMMENTS
        if(false) {
            console.log('-- skipping comment update for now on ', id)
        } else
        {
            const comments = ((await allCommentsByTicket)[id])||[]; // at least []
            const jiraComments = ((((jiraIssue||{}).fields.comment)||{}).comments) || []; // at least []
            // console.log('LENGTHS', comments.length, jiraComments.length);
            // Too many comments?!
            if(comments.length< jiraComments.length) {
                // delete excess comments
                const body='(deleted)\n';
                for(let c=comments.length; c<jiraComments.length; c++) {
                    if(jiraComments[c].body !== body) {
                        const errKey = `${issueKey}.${c}`;
                        const newComment = await jira.updateComment(issueKey, jiraComments[c].id, body)
                        .catch((e) => {
                            // TODO: closure on n?
                            errTix[errKey] = e.errors || e.message || e.toString();
                            console.error(errKey, (errTix[errKey] = e.errors || e.message || e.toString()));
                            return false;
                        });
                        // console.dir(newComment);
                    }
                }
                errTix[`${issueKey}.#`] = `Trac has ${comments.length} comments but ${jiraComments.length} in JIRA!`;
            }
            if(comments.length) {
                // For each comement:
                let n=0;
                for(const comment of comments) {
                    const jiraComment = (jiraComments||{})[n++]; // Try to find nth comment or null
                    const errKey = `${issueKey}.${(jiraComment||{}).id || n}`;
                    // console.dir(comment);
                    const jiraCommentOwner = await getReporterWithName(comment.author);
                    const commentAuthor = (jiraCommentOwner&&jiraCommentOwner.name)?`[~${jiraCommentOwner.name}]`:`${obfuscate(comment.author)}`;
                    let body = 
                        `h6. Trac Comment ${comment.oldvalue} by ${commentAuthor}—${new Date(comment.time/1000).toISOString()}\n` +
                        (await InterMapTxt).render({text: comment.newvalue, ticket, config, project, rev2ticket: await rev2ticket});
                    // If description is over the limit, truncate and move to a file
                    if(body.length > 32000) {
                        await mkdirp(`${config.db.attachmentPath}/${id}/`);
                        fs.writeFileSync(`${config.db.attachmentPath}/${id}/${issueKey}.${comment.oldvalue||n}.txt`, comment.newvalue, 'utf-8');
                        const abt = (await attachmentsByTicket);
                        abt[id] = abt[id] || [];
                        abt[id].push({
                            filename: `${issueKey}.${comment.oldvalue||n}.txt`
                        });
                        body = `h1. Text from ${commentAuthor} was too large\n\nLimit is about (${comment.newvalue.length}, >32k)\nSee attached ${issueKey}-${comment.oldvalue||n}.txt for original text.\n`;
                        ticket.keywords = (ticket.keywords||'')+' jira-overlong-description';
                    }
                    if(!jiraComment) {
                        // no jiraComment - add it.
                        const newComment = await jira.addComment(issueKey, body)
                        .catch((e) => {
                            // TODO: closure on n?
                            errTix[errKey] = e.errors || e.message || e.toString();
                            console.error(errKey, (errTix[errKey] = e.errors || e.message || e.toString()));
                            return false;
                        });
                        // console.dir(newComment);
                    } else {
                        const fields = {};
                        if(jiraComments[n-1].body !== body) {
                            fields.body = body;
                        }
                        // if(jiraCommentOwner && jiraCommentOwner.id) {
                        //     if(jiraComments[n-1].author.id !== jiraCommentOwner.id) {
                        //         fields.author = {id: jiraCommentOwner.id};
                        //     }
                        // } else {
                        //     //  change the owner to APIBot?
                        // }
                        if(Object.keys(fields).length) {
                            // Can't not set the content.
                            fields.body = body;
                            const errKey = `${issueKey}.${n}`;
                            console.dir(fields);
                            delete fields.body;  // body is in a separate param
                            const newComment = await jira.updateComment(issueKey, jiraComments[n-1].id, body, fields)
                            .catch((e) => {
                                // TODO: closure on n?
                                errTix[errKey] = e.errors || e.message || e.toString();
                                console.error(errKey, (errTix[errKey] = e.errors || e.message || e.toString()));
                                return false;
                            });
                            // console.dir(newComment);
                        }    
                    }
                }
            }
        }

        // ATTACHMENTS
        {
            const attaches = (await attachmentsByTicket)[id];
            if(attaches && attaches.length) {
                // console.dir({attaches, jattach: jiraIssue.fields.attachment});
                // For each attachment
                for(const attach of attaches) {
                    // console.dir(attach);
                    // Do we have this attachment already?
                    const subpath = attach.filename
                        .replace(/ /g,'%20')
                        .replace(/\[/g,'%5B')
                        .replace(/\$/g,'%24')
                        .replace(/\]/g,'%5D'); // hmm, do you think just maybe there might be a pattern here?
                    let foundCount = 0;
                    for(const jattach of (jiraIssue.fields.attachment || [])) {
                        if(jattach.filename === attach.filename || jattach.filename === subpath) {
                            foundCount++;
                            if(foundCount > 1) {
                                console.error('Delete extra attachment ' + jattach.id + ' from ' + id);
                                await deleteAttachment(jattach.id);
                            }
                        }
                    }
                    if(foundCount === 0) {
                        // now we attach
                        const filename = `${config.db.attachmentPath}/${id}/${subpath}`;
                        const attachResp = await jira.addAttachmentOnIssue(issueKey, fs.createReadStream(filename))
                        .catch((e) => {
                            errTix[`${id}.${attach.filename}`] = e.toString();
                            return null;
                        });
                        if(attachResp ) {
                            const ticketId = id;
                            if(attachResp && attachResp.length === 1) {
                                const {id, filename, size, mimeType} = attachResp[0];
                                console.log(`${chalk.dim(ticketId)} + ${chalk.bold.blue([id, filename, Number(size).toLocaleString()+'b', mimeType].join(' '))}\n`);
                            } else {
                                console.dir({attachResp});
                            }
                        }
                    }
                }
            }
        }                        
    }
}

/**
 * Give a summary
 */
function postscript() {
    console.log();
    if(errTix && Object.keys(errTix).length > 0) {
        process.exitCode = 1;
        console.dir(errTix, {depth: Infinity, color: true});
        console.error(`${chalk.red('Error')} in ${Object.keys(errTix).length} tickets.`);
    }
    if(updTix) {
        console.log(`Updated ${Object.keys(updTix).length}/${scanno} tickets.`);
    }
}

doit()
.then((x) => {
    console.dir(x);
    postscript();
    
}, (e) => {
    if (e.message) { console.error(e.message) } else { 
        process.exitCode = 1;
        console.error(e);
        postscript();
    }
});

Promise.all([
    allCommentsByTicket,

    attachmentsByTicket,
    allFields,
    project, issueTypes, ticketCount, components, priorities, versions, statuses, nameToIssueType,
jira, allTickets,

    _nameToComponent,
    _nameToPriority,
    _nameToVersion,
    _nameToStatus,
    

    ]).then(() => {}, (e) => console.error(e))
