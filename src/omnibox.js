const PAGE_TURNER = "-";
const URL_PROTOCOLS = /^(https?|file|chrome-extension|moz-extension):\/\//i;

class Omnibox {
    constructor(defaultSuggestion, maxSuggestionSize = 8) {
        this.maxSuggestionSize = maxSuggestionSize;
        this.defaultSuggestionDescription = defaultSuggestion;
        this.defaultSuggestionContent = null;
        this.queryEvents = [];
        // Cache the last query and result to speed up the page down.
        this.cachedQuery = null;
        this.cachedResult = null;
        // A set of query which should not be cached.
        this.noCacheQueries = new Set();
    }

    setDefaultSuggestion(description, content) {
        chrome.omnibox.setDefaultSuggestion({description});

        if (content) {
            this.defaultSuggestionContent = content;
        }
    }

    parse(input) {
        let parsePage = (arg) => {
            return [...arg].filter(c => c === PAGE_TURNER).length + 1;
        };
        let args = input.trim().split(/\s+/i);
        let query = undefined, page = 1;
        if (args.length === 1) {
            // Case: {keyword}
            query = [args[0]];
        } else if (args.length === 2 && args[1].startsWith(PAGE_TURNER)) {
            // Case: {keyword} {page-turner}
            query = [args[0]];
            page = parsePage(args[1]);
        } else if (args.length >= 2) {
            // Case: {keyword} {keyword} {page-turner}
            query = [args[0], args[1]];
            if (args[2] && args[2].startsWith(PAGE_TURNER)) {
                page = parsePage(args[2]);
            }
        }
        return {query: query.join(" "), page};
    }

    bootstrap({onSearch, onFormat, onAppend, onEmptyNavigate, beforeNavigate, afterNavigated}) {
        this.globalEvent = new QueryEvent({onSearch, onFormat, onAppend});
        this.setDefaultSuggestion(this.defaultSuggestionDescription);
        let results;
        let currentInput;
        let defaultDescription;

        chrome.omnibox.onInputChanged.addListener(async (input, suggestFn) => {
            this.defaultSuggestionContent = null;
            if (!input) {
                this.setDefaultSuggestion(this.defaultSuggestionDescription);
                return;
            }

            currentInput = input;
            let {query, page} = this.parse(input);
            // Always perform search if query is a noCachedQuery, then check whether equals to cachedQuery
            if (this.noCacheQueries.has(query) || this.cachedQuery !== query) {
                results = this.performSearch(query);
                this.cachedQuery = query;
                this.cachedResult = results;
            } else {
                results = this.cachedResult;
            }

            let totalPage = Math.ceil(results.length / this.maxSuggestionSize);
            let uniqueUrls = new Set();
            // Slice the page data then format this data.
            results = results
                .slice(this.maxSuggestionSize * (page - 1), this.maxSuggestionSize * page)
                .map(({event, ...item}, index) => {
                    if (event) {
                        // onAppend result has event.
                        item = event.format(item, index);
                    }
                    if (uniqueUrls.has(item.content)) {
                        item.content += `?${uniqueUrls.size + 1}`;
                    }
                    uniqueUrls.add(item.content);
                    return item;
                });
            if (results.length > 0) {
                let {content, description} = results.shift();
                // Store the default description temporary.
                defaultDescription = description;
                description += ` | Page [${page}/${totalPage}], append '${PAGE_TURNER}' to page down`;
                this.setDefaultSuggestion(description, content);
            }
            suggestFn(results);
        });

        chrome.omnibox.onInputEntered.addListener((content, disposition) => {
            let result;
            // Give beforeNavigate a default function
            beforeNavigate = beforeNavigate || ((_, s) => s);

            // A flag indicates whether the url navigate success
            let navigated = false;
            // The first item (aka default suggestion) is special in Chrome extension API,
            // here the content is the user input.
            if (content === currentInput) {
                content = beforeNavigate(this.cachedQuery, this.defaultSuggestionContent);
                result = {
                    content,
                    description: defaultDescription,
                };
                if (URL_PROTOCOLS.test(content)) {
                    Omnibox.navigateToUrl(content, disposition);
                    navigated = true;
                }
            } else {
                // Store raw content before navigate to find the correct result
                let rawContent = content;
                result = results.find(item => item.content === rawContent);
                content = beforeNavigate(this.cachedQuery, content);
                if (URL_PROTOCOLS.test(content)) {
                    Omnibox.navigateToUrl(content, disposition);
                    navigated = true;

                    // Ensure the result.content is the latest,
                    // since the content returned by beforeNavigate() could be different from the raw one.
                    if (result) {
                        result.content = content;
                    }
                }
            }

            if (!navigated && onEmptyNavigate) {
                onEmptyNavigate(content, disposition);
            }

            if (afterNavigated) {
                afterNavigated(this.cachedQuery, result);
            }

            this.setDefaultSuggestion(this.defaultSuggestionDescription);
        });
    }

    performSearch(query) {
        let result;
        let matchedEvent = this.queryEvents
            .sort((a, b) => {
                // Descend sort query events by prefix length to prioritize
                // the longer prefix than the shorter one when performing matches
                if (a.prefix && b.prefix) {
                    return b.prefix.length - a.prefix.length;
                }
                return 0;
            }).find(event => {
                return (event.prefix && query.startsWith(event.prefix)) || (event.regex && event.regex.test(query));
            });

        if (matchedEvent) {
            result = matchedEvent.performSearch(query);
            if (matchedEvent.onAppend) {
                result.push(...matchedEvent.onAppend(query));
            }
        } else {
            result = this.globalEvent.performSearch(query);
            let defaultSearchEvents = this.queryEvents
                .filter(event => event.defaultSearch)
                .sort((a, b) => b.searchPriority - a.searchPriority);
            let defaultSearchAppendixes = [];
            for (let event of defaultSearchEvents) {
                result.push(...event.performSearch(query));
                if (event.onAppend) {
                    defaultSearchAppendixes.push(...event.onAppend(query));
                }
            }
            result.push(...this.globalEvent.onAppend(query));
            result.push(...defaultSearchAppendixes);
        }
        return result;
    }

    addNoCacheQueries(...queries) {
        queries.forEach(query => this.noCacheQueries.add(query));
    }

    addQueryEvent(event) {
        this.queryEvents.push(event);
    }

    addPrefixQueryEvent(prefix, event) {
        this.addQueryEvent(new QueryEvent({
            prefix,
            ...event,
        }));
    }

    addRegexQueryEvent(regex, event) {
        this.addQueryEvent(new QueryEvent({
            regex,
            ...event,
        }));
    }

    /**
     * Open the url according to the disposition rule.
     *
     * Disposition rules:
     * - currentTab: enter (default)
     * - newForegroundTab: alt + enter
     * - newBackgroundTab: meta + enter
     */
    static navigateToUrl(url, disposition) {
        url = url.replace(/\?\d+$/ig, "");
        if (disposition === "currentTab") {
            chrome.tabs.query({active: true}, tab => {
                chrome.tabs.update(tab.id, {url});
            });
        } else {
            // newForegroundTab, newBackgroundTab
            chrome.tabs.create({url});
        }
    }
}
