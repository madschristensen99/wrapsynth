export declare const IDL: {
    version: string;
    name: string;
    instructions: {
        name: string;
        accounts: {
            name: string;
            isMut: boolean;
            isSigner: boolean;
        }[];
        args: ({
            name: string;
            type: {
                array: (string | number)[];
            };
        } | {
            name: string;
            type: string;
        })[];
    }[];
    accounts: {
        name: string;
        type: {
            kind: string;
            fields: ({
                name: string;
                type: {
                    defined: string;
                    array?: undefined;
                };
            } | {
                name: string;
                type: {
                    array: (string | number)[];
                    defined?: undefined;
                };
            } | {
                name: string;
                type: string;
            })[];
        };
    }[];
    types: {
        name: string;
        type: {
            kind: string;
            variants: {
                name: string;
            }[];
        };
    }[];
};
